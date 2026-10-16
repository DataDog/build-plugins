// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, mkdir, outputFile, readFile, rm } from '@dd/core/helpers/fs';
import { ROOT } from '@dd/tools/constants';
import os from 'os';
import { outdent } from 'outdent';
import path from 'path';

import { assertJavaScriptSyntax } from '../assertions/javascript';
import {
    assertLiveDebuggerArtifacts,
    assertLiveDebuggerBuildOutput,
} from '../assertions/live-debugger';
import { getTargetCommandEnvironment } from '../environment';
import type { JsonObject } from '../files';
import { isJsonObject, readFiles, readJsonObject, restoreSnapshots } from '../files';
import { CanaryCommandError, runCheckedCommand } from '../runner';
import type {
    ArtifactSpec,
    CanaryPhase,
    CanaryTarget,
    CanaryVariant,
    CommandSpec,
    TargetSetupContext,
} from '../types';

const VITE_PACKAGE = '@datadog/vite-plugin';
const VITE_PACKAGE_JSON = 'packages/published/vite-plugin/package.json';
const LIVE_DEBUGGER_PEER_DEPENDENCIES = ['@babel/parser', '@babel/traverse', '@babel/types'];
const EXCALIDRAW_PACKAGE_NAME = 'excalidraw-monorepo';
const EXCALIDRAW_PACKAGE_JSON = 'package.json';
const EXCALIDRAW_LOCKFILE = 'yarn.lock';
const EXCALIDRAW_DEPENDENCIES = 'node_modules';
const APP_DIRECTORY = 'excalidraw-app';
const APP_CONFIG = 'vite.config.mts';
const CANARY_CONFIG = 'vite.config.live-debugger-canary.mjs';
const CANARY_OUTPUT_DIRECTORY = 'build/live-debugger-canary';
const JAVASCRIPT_PATTERNS = ['**/*.js'];
const LIVE_DEBUGGER_ENV = 'BUILD_PLUGIN_LIVE_DEBUGGER';
const NAMED_ONLY_ENV = 'BUILD_PLUGIN_LIVE_DEBUGGER_NAMED_ONLY';
const PHASE_ID = 'app';

// Live Debugger instrumentation pushes the main chunk past the app's service-worker
// precache limit, which vite-plugin-pwa reports as a build error. Downgrading it to a
// warning in both variants keeps the comparison running; the oversized chunk is left
// out of the precache manifest instead.
const PWA_PLUGIN_CALL = 'VitePWA({';
const PWA_PLUGIN_CALL_WITH_SIZE_WARNING =
    'VitePWA({ showMaximumFileSizeToCacheInBytesWarning: true,';

// The base config is imported through its .mjs specifier: Vite's config bundler and
// TypeScript both resolve it to vite.config.mts, while a literal .mts specifier fails
// the type check that Excalidraw runs during its build.
const CANARY_CONFIG_SOURCE = outdent`
    import { datadogVitePlugin } from '${VITE_PACKAGE}';
    import { defineConfig, mergeConfig } from 'vite';

    import baseConfig from './vite.config.mjs';

    export default defineConfig(async (env) => {
        const config = typeof baseConfig === 'function' ? await baseConfig(env) : await baseConfig;
        return mergeConfig(config, {
            plugins: [
                datadogVitePlugin({
                    logLevel: 'info',
                    liveDebugger: {
                        enable: process.env.${LIVE_DEBUGGER_ENV} === 'true',
                        namedOnly: process.env.${NAMED_ONLY_ENV} === 'true',
                    },
                }),
            ],
        });
    });
`;

export const allowOversizedPrecacheAssets = (config: string): string => {
    const occurrences = config.split(PWA_PLUGIN_CALL).length - 1;
    if (occurrences !== 1) {
        throw new CanaryCommandError(
            `Expected one "${PWA_PLUGIN_CALL}" call in ${APP_CONFIG}, found ${occurrences}. Update the Excalidraw canary target.`,
        );
    }
    return config.replace(PWA_PLUGIN_CALL, PWA_PLUGIN_CALL_WITH_SIZE_WARNING);
};

export const getPeerDependencySpecifiers = (packageJson: JsonObject): string[] => {
    const peerDependencies = packageJson.peerDependencies;
    if (!isJsonObject(peerDependencies)) {
        throw new CanaryCommandError(`${VITE_PACKAGE} does not declare peer dependencies.`);
    }

    return LIVE_DEBUGGER_PEER_DEPENDENCIES.map((name) => {
        const range = peerDependencies[name];
        if (typeof range !== 'string') {
            throw new CanaryCommandError(
                `${VITE_PACKAGE} does not declare a peer dependency on ${name}.`,
            );
        }
        return `${name}@${range}`;
    });
};

const getOutputDirectory = (variant: CanaryVariant): string => {
    return `${CANARY_OUTPUT_DIRECTORY}/${PHASE_ID}/${variant}`;
};

const getArtifactSpec = (root: string, variant: CanaryVariant): ArtifactSpec => {
    const outputDirectory = getOutputDirectory(variant);
    return {
        roots: [path.resolve(root, APP_DIRECTORY, outputDirectory)],
        patterns: JAVASCRIPT_PATTERNS,
    };
};

const getBuildCommand = (root: string, variant: CanaryVariant): CommandSpec => {
    const outputDirectory = getOutputDirectory(variant);
    const targetEnvironment = getTargetCommandEnvironment(process.env);
    return {
        command: 'yarn',
        args: [
            'build:app',
            '--config',
            CANARY_CONFIG,
            '--outDir',
            outputDirectory,
            '--emptyOutDir',
        ],
        cwd: path.resolve(root, APP_DIRECTORY),
        env: {
            ...targetEnvironment,
            [LIVE_DEBUGGER_ENV]: variant === 'control' ? 'false' : 'true',
            [NAMED_ONLY_ENV]: variant === 'named-only' ? 'true' : 'false',
        },
        label: `${PHASE_ID} ${variant} build`,
    };
};

const assertArtifacts = async (filePaths: string[], variant: CanaryVariant): Promise<void> => {
    await assertJavaScriptSyntax(filePaths);
    await assertLiveDebuggerArtifacts(filePaths, variant);
};

export const createExcalidrawPhase = (): CanaryPhase => {
    return {
        id: PHASE_ID,
        buildTool: 'vite',
        localPackages: [VITE_PACKAGE],
        getArtifactSpec,
        getBuildCommand,
        assertBuildOutput: assertLiveDebuggerBuildOutput,
        assertArtifacts,
    };
};

const hasDependency = (packageJson: JsonObject, name: string): boolean => {
    return ['dependencies', 'devDependencies'].some((field) => {
        const dependencies = packageJson[field];
        return isJsonObject(dependencies) && name in dependencies;
    });
};

const preflightExcalidraw = async ({ root }: TargetSetupContext): Promise<void> => {
    const packageJsonPath = path.resolve(root, EXCALIDRAW_PACKAGE_JSON);
    const appConfigPath = path.resolve(root, APP_DIRECTORY, APP_CONFIG);
    const packageJson = existsSync(packageJsonPath)
        ? await readJsonObject(packageJsonPath)
        : undefined;
    if (packageJson?.name !== EXCALIDRAW_PACKAGE_NAME || !existsSync(appConfigPath)) {
        throw new CanaryCommandError(
            `${root} does not look like an Excalidraw checkout. Pass its path with --root.`,
        );
    }

    const dependenciesPath = path.resolve(root, EXCALIDRAW_DEPENDENCIES);
    if (!existsSync(dependenciesPath)) {
        throw new CanaryCommandError(
            'Excalidraw dependencies are not installed. Run "yarn install --frozen-lockfile" in its checkout first.',
        );
    }

    if (hasDependency(packageJson, VITE_PACKAGE)) {
        throw new CanaryCommandError(
            `Excalidraw already depends on ${VITE_PACKAGE}. Remove it before running the canary.`,
        );
    }

    const canaryConfigPath = path.resolve(root, APP_DIRECTORY, CANARY_CONFIG);
    if (existsSync(canaryConfigPath)) {
        throw new CanaryCommandError(
            `${canaryConfigPath} already exists. Remove it before running the canary.`,
        );
    }

    // Fail before setup changes anything if the config no longer has the expected shape.
    const appConfig = await readFile(appConfigPath);
    allowOversizedPrecacheAssets(appConfig);
};

const setupExcalidraw = async ({
    buildPluginsRoot,
    registerCleanup,
    root,
    runCommand,
}: TargetSetupContext): Promise<void> => {
    const packageJsonPath = path.resolve(root, EXCALIDRAW_PACKAGE_JSON);
    const lockfilePath = path.resolve(root, EXCALIDRAW_LOCKFILE);
    const dependencySnapshots = await readFiles([packageJsonPath, lockfilePath]);
    const targetEnvironment = getTargetCommandEnvironment(process.env);
    const packDirectory = path.resolve(
        os.tmpdir(),
        `build-plugins-canary-excalidraw-${process.pid}-${Date.now()}`,
    );
    // A unique tarball path keeps Yarn from reusing a cached copy from a previous run.
    const tarballPath = path.resolve(packDirectory, 'datadog-vite-plugin.tgz');

    registerCleanup({
        name: 'vite-plugin-tarball',
        run: async () => {
            await rm(packDirectory);
        },
    });
    await mkdir(packDirectory);

    // Packing applies publishConfig, so Excalidraw resolves the built files without
    // modifying the build-plugins checkout.
    const packSpec: CommandSpec = {
        command: 'yarn',
        args: ['workspace', VITE_PACKAGE, 'pack', '--out', tarballPath],
        cwd: buildPluginsRoot,
        label: `pack ${VITE_PACKAGE}`,
    };
    await runCheckedCommand(runCommand, packSpec);

    registerCleanup({
        name: 'excalidraw-dependencies',
        run: async () => {
            await restoreSnapshots(dependencySnapshots);
            const installSpec: CommandSpec = {
                command: 'yarn',
                args: ['install', '--frozen-lockfile'],
                cwd: root,
                env: targetEnvironment,
                label: 'restore Excalidraw dependency state',
            };
            await runCheckedCommand(runCommand, installSpec);
        },
    });

    const vitePackageJsonPath = path.resolve(buildPluginsRoot, VITE_PACKAGE_JSON);
    const vitePackageJson = await readJsonObject(vitePackageJsonPath);
    const peerDependencies = getPeerDependencySpecifiers(vitePackageJson);
    const addSpec: CommandSpec = {
        command: 'yarn',
        args: [
            'add',
            '--dev',
            '--ignore-workspace-root-check',
            `file:${tarballPath}`,
            ...peerDependencies,
        ],
        cwd: root,
        env: targetEnvironment,
        label: `install local ${VITE_PACKAGE} into Excalidraw`,
    };
    await runCheckedCommand(runCommand, addSpec);

    const appConfigPath = path.resolve(root, APP_DIRECTORY, APP_CONFIG);
    const canaryConfigPath = path.resolve(root, APP_DIRECTORY, CANARY_CONFIG);
    const appConfig = await readFile(appConfigPath);
    const configSnapshots = new Map([[appConfigPath, appConfig]]);
    registerCleanup({
        name: 'excalidraw-config',
        run: async () => {
            await rm(canaryConfigPath);
            await restoreSnapshots(configSnapshots);
        },
    });

    const patchedConfig = allowOversizedPrecacheAssets(appConfig);
    await outputFile(appConfigPath, patchedConfig);
    await outputFile(canaryConfigPath, `${CANARY_CONFIG_SOURCE}\n`);
};

export const excalidrawTarget: CanaryTarget = {
    id: 'excalidraw',
    getDefaultRoot: () => path.resolve(ROOT, '../excalidraw'),
    getPhases: () => [createExcalidrawPhase()],
    preflight: preflightExcalidraw,
    setup: setupExcalidraw,
};
