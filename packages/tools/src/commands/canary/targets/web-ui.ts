// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, outputFile, readFile } from '@dd/core/helpers/fs';
import { ROOT } from '@dd/tools/constants';
import { glob } from 'glob';
import path from 'path';

import {
    assertLiveDebuggerArtifacts,
    assertLiveDebuggerBuildOutput,
} from '../assertions/live-debugger';
import { CanaryCommandError, runCheckedCommand } from '../runner';
import type {
    ArtifactSpec,
    CanaryPhase,
    CanaryTarget,
    CanaryVariant,
    CommandSpec,
    TargetSetupContext,
} from '../types';

const RSPACK_PACKAGE = '@datadog/rspack-plugin';
const RSPACK_PACKAGE_PATH = path.resolve(ROOT, 'packages/published/rspack-plugin');
const WEB_UI_PACKAGE_JSON = 'package.json';
const WEB_UI_LOCKFILE = 'yarn.lock';
const WEB_UI_BUILD_COMMAND = 'packages/apps/devx/commands/build-spa/build-spa.ts';
const CANARY_OUTPUT_PREFIX = 'live-debugger-canary';
const JAVASCRIPT_PATTERNS = ['**/*.js'];
const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 16_384;

const MAIN_ENTRIES = [
    'spa-rspack',
    'react-core-rspack',
    'dd-login-rspack',
    'embed-rspack',
    'polyfills-rspack',
    'spa-internal-rspack',
    'snapshot-print-rspack',
];

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const parseJsonObject = (content: string, filePath: string): JsonObject => {
    const value: unknown = JSON.parse(content);
    if (!isJsonObject(value)) {
        throw new CanaryCommandError(`${filePath} does not contain a JSON object.`);
    }
    return value;
};

export const containsLinkReference = (value: unknown): boolean => {
    if (typeof value === 'string') {
        return /^(?:link|portal):/.test(value);
    }
    if (Array.isArray(value)) {
        return value.some((entry) => containsLinkReference(entry));
    }
    if (!isJsonObject(value)) {
        return false;
    }
    return Object.values(value).some((entry) => containsLinkReference(entry));
};

const getPublishedPackageJsonFiles = async (buildPluginsRoot: string): Promise<string[]> => {
    return glob('packages/published/*-plugin/package.json', {
        absolute: true,
        cwd: buildPluginsRoot,
        nodir: true,
    });
};

const assertPublishedPackagesAreNotPrepared = async (buildPluginsRoot: string): Promise<void> => {
    const packageFiles = await getPublishedPackageJsonFiles(buildPluginsRoot);
    for (const packageFile of packageFiles) {
        const content = await readFile(packageFile);
        const packageJson = parseJsonObject(content, packageFile);
        if ('previousExports' in packageJson) {
            throw new CanaryCommandError(
                `Published packages are already prepared for linking. Revert them before running the canary.`,
            );
        }
    }
};

const assertPublishedPackagesArePrepared = async (buildPluginsRoot: string): Promise<void> => {
    const packageFiles = await getPublishedPackageJsonFiles(buildPluginsRoot);
    for (const packageFile of packageFiles) {
        const content = await readFile(packageFile);
        const packageJson = parseJsonObject(content, packageFile);
        if (!('previousExports' in packageJson)) {
            throw new CanaryCommandError(
                `The prepare-link command did not prepare ${packageFile}.`,
            );
        }
    }
};

const readFiles = async (filePaths: string[]): Promise<Map<string, string>> => {
    const files = new Map<string, string>();
    for (const filePath of filePaths) {
        const content = await readFile(filePath);
        files.set(filePath, content);
    }
    return files;
};

const restoreSnapshots = async (snapshots: Map<string, string>): Promise<void> => {
    for (const [filePath, expected] of snapshots) {
        const actual = await readFile(filePath);
        if (actual !== expected) {
            await outputFile(filePath, expected);
        }
    }
};

const getOutputSubdirectories = (
    phaseId: string,
    variant: CanaryVariant,
): { chunk: string; entry: string } => {
    return {
        entry: `v/${CANARY_OUTPUT_PREFIX}/${phaseId}/${variant}/js`,
        chunk: `${CANARY_OUTPUT_PREFIX}/${phaseId}/${variant}/chunks`,
    };
};

const getArtifactSpec = (root: string, phaseId: string, variant: CanaryVariant): ArtifactSpec => {
    const subdirectories = getOutputSubdirectories(phaseId, variant);
    const staticRoot = path.resolve(root, 'public/static');

    return {
        roots: [
            path.resolve(staticRoot, subdirectories.entry),
            path.resolve(staticRoot, subdirectories.chunk),
        ],
        patterns: JAVASCRIPT_PATTERNS,
    };
};

const getBuildEnvironment = (variant: CanaryVariant): Record<string, string> => {
    const existingNodeOptions = process.env.NODE_OPTIONS?.trim() ?? '';
    const hasHeapLimit = /--max[-_]old[-_]space[-_]size(?:=|\s)/.test(existingNodeOptions);
    const heapOption = `--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_SIZE_MB}`;
    const nodeOptions = hasHeapLimit
        ? existingNodeOptions
        : `${existingNodeOptions} ${heapOption}`.trim();

    return {
        BUILD_PLUGIN_DISABLE_METRICS: 'true',
        BUILD_PLUGIN_DISABLE_SOURCEMAPS: 'true',
        BUILD_PLUGIN_LIVE_DEBUGGER: variant === 'instrumented' ? 'true' : 'false',
        BUILD_PLUGIN_RUM_PRIVACY: 'true',
        BUILD_PLUGIN_UPLOAD_SOURCEMAPS: 'false',
        NODE_OPTIONS: nodeOptions,
    };
};

const getOutputArguments = (phaseId: string, variant: CanaryVariant): string[] => {
    const subdirectories = getOutputSubdirectories(phaseId, variant);
    return [`--entry-subdir=${subdirectories.entry}`, `--chunk-subdir=${subdirectories.chunk}`];
};

const getPhaseArguments = (phaseId: string): string[] => {
    if (phaseId === 'main') {
        return ['--bundler=rspack', `--entries=${MAIN_ENTRIES.join(',')}`];
    }
    return ['--bundler=rspack', '--split-deploys', '--entry-preset=split-deploys'];
};

const getBuildCommand = (root: string, phaseId: string, variant: CanaryVariant): CommandSpec => {
    const phaseArguments = getPhaseArguments(phaseId);
    const outputArguments = getOutputArguments(phaseId, variant);
    return {
        command: 'yarn',
        args: [
            'cli',
            'build-spa',
            ...phaseArguments,
            ...outputArguments,
            '--clean',
            '--no-validate',
        ],
        cwd: root,
        env: getBuildEnvironment(variant),
        label: `${phaseId} ${variant} build`,
    };
};

const getValidationCommand = (
    root: string,
    phaseId: string,
    variant: CanaryVariant,
): CommandSpec => {
    const outputArguments = getOutputArguments(phaseId, variant);
    return {
        command: 'yarn',
        args: ['cli', 'build-spa', ...outputArguments, '--no-build', '--validate'],
        cwd: root,
        label: `${phaseId} ${variant} JavaScript validation`,
    };
};

export const createWebUiPhase = (id: 'main' | 'federated'): CanaryPhase => {
    return {
        id,
        buildTool: 'rspack',
        localPackages: [RSPACK_PACKAGE],
        getArtifactSpec: (root, variant) => getArtifactSpec(root, id, variant),
        getBuildCommand: (root, variant) => getBuildCommand(root, id, variant),
        getValidationCommand: (root, variant) => getValidationCommand(root, id, variant),
        assertBuildOutput: assertLiveDebuggerBuildOutput,
        assertArtifacts: assertLiveDebuggerArtifacts,
    };
};

const preflightWebUi = async ({ buildPluginsRoot, root }: TargetSetupContext): Promise<void> => {
    const packageJsonPath = path.resolve(root, WEB_UI_PACKAGE_JSON);
    const buildCommandPath = path.resolve(root, WEB_UI_BUILD_COMMAND);
    if (!existsSync(packageJsonPath) || !existsSync(buildCommandPath)) {
        throw new CanaryCommandError(
            `${root} does not look like a web-ui checkout. Pass its path with --root.`,
        );
    }

    await assertPublishedPackagesAreNotPrepared(buildPluginsRoot);

    const packageJsonContent = await readFile(packageJsonPath);
    const packageJson = parseJsonObject(packageJsonContent, packageJsonPath);
    if (containsLinkReference(packageJson)) {
        throw new CanaryCommandError(
            'web-ui already contains a link or portal resolution. Unlink it before running the canary.',
        );
    }
};

const setupWebUi = async ({
    buildPluginsRoot,
    registerCleanup,
    root,
    runCommand,
}: TargetSetupContext): Promise<void> => {
    const packageFiles = await getPublishedPackageJsonFiles(buildPluginsRoot);
    const publishedSnapshots = await readFiles(packageFiles);
    const webUiPackageJsonPath = path.resolve(root, WEB_UI_PACKAGE_JSON);
    const webUiLockfilePath = path.resolve(root, WEB_UI_LOCKFILE);
    const webUiSnapshots = await readFiles([webUiPackageJsonPath, webUiLockfilePath]);

    const buildSpec: CommandSpec = {
        command: 'yarn',
        args: ['workspace', RSPACK_PACKAGE, 'build'],
        cwd: buildPluginsRoot,
        label: `build ${RSPACK_PACKAGE}`,
    };
    await runCheckedCommand(runCommand, buildSpec);

    registerCleanup({
        name: 'published-package-exports',
        run: async () => {
            const revertSpec: CommandSpec = {
                command: 'yarn',
                args: ['cli', 'prepare-link', '--revert'],
                cwd: buildPluginsRoot,
                label: 'revert prepared package exports',
            };
            await runCheckedCommand(runCommand, revertSpec);
            await restoreSnapshots(publishedSnapshots);
        },
    });

    const prepareSpec: CommandSpec = {
        command: 'yarn',
        args: ['cli', 'prepare-link'],
        cwd: buildPluginsRoot,
        label: 'prepare published package exports',
    };
    await runCheckedCommand(runCommand, prepareSpec);
    await assertPublishedPackagesArePrepared(buildPluginsRoot);

    registerCleanup({
        name: 'web-ui-link',
        run: async () => {
            const unlinkSpec: CommandSpec = {
                command: 'yarn',
                args: ['unlink', '--all'],
                cwd: root,
                label: 'unlink build plugins from web-ui',
            };
            await runCheckedCommand(runCommand, unlinkSpec);
            await restoreSnapshots(webUiSnapshots);

            const installSpec: CommandSpec = {
                command: 'yarn',
                args: ['install', '--immutable', '--mode=skip-build'],
                cwd: root,
                label: 'restore web-ui dependency state',
            };
            await runCheckedCommand(runCommand, installSpec);
        },
    });

    const linkSpec: CommandSpec = {
        command: 'yarn',
        args: ['link', '-Ap', RSPACK_PACKAGE_PATH],
        cwd: root,
        label: 'link local Rspack plugin into web-ui',
    };
    await runCheckedCommand(runCommand, linkSpec);
};

export const webUiTarget: CanaryTarget = {
    id: 'web-ui',
    getDefaultRoot: () => {
        const datadogRoot = process.env.DATADOG_ROOT;
        return datadogRoot ? path.resolve(datadogRoot, 'web-ui') : path.resolve(ROOT, '../web-ui');
    },
    getPhases: () => [createWebUiPhase('main'), createWebUiPhase('federated')],
    preflight: preflightWebUi,
    setup: setupWebUi,
};
