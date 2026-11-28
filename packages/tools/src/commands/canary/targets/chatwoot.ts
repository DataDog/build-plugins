// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, outputFile, rm } from '@dd/core/helpers/fs';
import { ROOT } from '@dd/tools/constants';
import path from 'path';

import {
    assertFileExtensionInstrumented,
    assertLiveDebuggerBuildOutput,
} from '../assertions/live-debugger';
import { getTargetCommandEnvironment } from '../environment';
import { readFiles, readJsonObject, restoreSnapshots } from '../files';
import { CanaryCommandError, runCheckedCommand } from '../runner';
import type {
    ArtifactSpec,
    CanaryPhase,
    CanaryTarget,
    CanaryVariant,
    CommandSpec,
    TargetSetupContext,
} from '../types';
import {
    assertViteArtifacts,
    getCanaryViteConfig,
    getViteBuildEnvironment,
    hasDependency,
    packVitePlugin,
    VITE_PACKAGE,
} from '../vite-plugin';

const TARGET_ID = 'chatwoot';
const CHATWOOT_PACKAGE_NAME = '@chatwoot/chatwoot';
const CHATWOOT_PACKAGE_JSON = 'package.json';
const CHATWOOT_LOCKFILE = 'pnpm-lock.yaml';
const CHATWOOT_DEPENDENCIES = 'node_modules';
const APP_CONFIG = 'vite.config.ts';
const BASE_CONFIG_SPECIFIER = `./${APP_CONFIG}`;
const CANARY_CONFIG = 'vite.config.live-debugger-canary.mjs';
const JAVASCRIPT_PATTERNS = ['**/*.js'];
const PHASE_ID = 'app';

// Live Debugger doesn't instrument Vue single-file components by default.
const VUE_FILE_EXTENSION = '.vue';

// Chatwoot's Vite config uses vite-plugin-ruby, which ignores --outDir. It
// writes to `<publicDir>/<publicOutputDir>` and also puts publicOutputDir in the
// URLs it emits. So each variant gets its own publicDir, and every variant keeps
// publicOutputDir at `vite`, the value Chatwoot's production build uses. These
// variables take precedence over `config/vite.json`.
const PUBLIC_DIR_ENV = 'VITE_RUBY_PUBLIC_DIR';
const PUBLIC_OUTPUT_DIR_ENV = 'VITE_RUBY_PUBLIC_OUTPUT_DIR';
const PUBLIC_OUTPUT_DIR = 'vite';
// Chatwoot's .gitignore covers `/public/vite*`.
const CANARY_PUBLIC_DIRECTORY = 'public/vite-live-debugger-canary';

// vite-plugin-ruby takes its mode from RAILS_ENV before Vite's own. Chatwoot
// builds its production assets with RAILS_ENV=production.
const RAILS_ENV = 'production';

const getPublicDirectory = (variant: CanaryVariant): string => {
    return `${CANARY_PUBLIC_DIRECTORY}/${PHASE_ID}/${variant}`;
};

const getArtifactSpec = (root: string, variant: CanaryVariant): ArtifactSpec => {
    const publicDirectory = getPublicDirectory(variant);
    return {
        roots: [path.resolve(root, publicDirectory, PUBLIC_OUTPUT_DIR)],
        patterns: JAVASCRIPT_PATTERNS,
    };
};

const getBuildCommand = (root: string, variant: CanaryVariant): CommandSpec => {
    return {
        command: 'pnpm',
        args: ['exec', 'vite', 'build', '--config', CANARY_CONFIG, '--emptyOutDir'],
        cwd: root,
        env: {
            ...getViteBuildEnvironment(variant),
            RAILS_ENV,
            [PUBLIC_DIR_ENV]: getPublicDirectory(variant),
            [PUBLIC_OUTPUT_DIR_ENV]: PUBLIC_OUTPUT_DIR,
        },
        label: `${PHASE_ID} ${variant} build`,
    };
};

const assertChatwootArtifacts = async (
    filePaths: string[],
    variant: CanaryVariant,
): Promise<void> => {
    await assertViteArtifacts(filePaths, variant);
    await assertFileExtensionInstrumented(filePaths, variant, VUE_FILE_EXTENSION);
};

export const createChatwootPhase = (): CanaryPhase => {
    return {
        id: PHASE_ID,
        buildTool: 'vite',
        localPackages: [VITE_PACKAGE],
        getArtifactSpec,
        getBuildCommand,
        assertBuildOutput: assertLiveDebuggerBuildOutput,
        assertArtifacts: assertChatwootArtifacts,
    };
};

const installChatwoot = async ({ root, runCommand }: TargetSetupContext): Promise<void> => {
    const targetEnvironment = getTargetCommandEnvironment(process.env);
    const installSpec: CommandSpec = {
        command: 'pnpm',
        args: ['install', '--frozen-lockfile'],
        cwd: root,
        env: targetEnvironment,
        label: 'install Chatwoot dependencies',
    };
    await runCheckedCommand(runCommand, installSpec);
};

const preflightChatwoot = async ({ root }: TargetSetupContext): Promise<void> => {
    const packageJsonPath = path.resolve(root, CHATWOOT_PACKAGE_JSON);
    const appConfigPath = path.resolve(root, APP_CONFIG);
    const packageJson = existsSync(packageJsonPath)
        ? await readJsonObject(packageJsonPath)
        : undefined;
    if (packageJson?.name !== CHATWOOT_PACKAGE_NAME || !existsSync(appConfigPath)) {
        throw new CanaryCommandError(
            `${root} does not look like a Chatwoot checkout. Pass its path with --root.`,
        );
    }

    const dependenciesPath = path.resolve(root, CHATWOOT_DEPENDENCIES);
    if (!existsSync(dependenciesPath)) {
        throw new CanaryCommandError(
            'Chatwoot dependencies are not installed. Run "pnpm install --frozen-lockfile" in its checkout first, or pass --install.',
        );
    }

    if (hasDependency(packageJson, VITE_PACKAGE)) {
        throw new CanaryCommandError(
            `Chatwoot already depends on ${VITE_PACKAGE}. Remove it before running the canary.`,
        );
    }

    const canaryConfigPath = path.resolve(root, CANARY_CONFIG);
    if (existsSync(canaryConfigPath)) {
        throw new CanaryCommandError(
            `${canaryConfigPath} already exists. Remove it before running the canary.`,
        );
    }
};

const setupChatwoot = async (context: TargetSetupContext): Promise<void> => {
    const { registerCleanup, root, runCommand } = context;
    const packageJsonPath = path.resolve(root, CHATWOOT_PACKAGE_JSON);
    const lockfilePath = path.resolve(root, CHATWOOT_LOCKFILE);
    const dependencySnapshots = await readFiles([packageJsonPath, lockfilePath]);
    const targetEnvironment = getTargetCommandEnvironment(process.env);
    const packageSpecifiers = await packVitePlugin(context, TARGET_ID);

    registerCleanup({
        name: 'chatwoot-dependencies',
        run: async () => {
            await restoreSnapshots(dependencySnapshots);
            const installSpec: CommandSpec = {
                command: 'pnpm',
                args: ['install', '--frozen-lockfile'],
                cwd: root,
                env: targetEnvironment,
                label: 'restore Chatwoot dependency state',
            };
            await runCheckedCommand(runCommand, installSpec);
        },
    });

    const addSpec: CommandSpec = {
        command: 'pnpm',
        args: ['add', '--save-dev', ...packageSpecifiers],
        cwd: root,
        env: targetEnvironment,
        label: `install local ${VITE_PACKAGE} into Chatwoot`,
    };
    await runCheckedCommand(runCommand, addSpec);

    const canaryConfigPath = path.resolve(root, CANARY_CONFIG);
    registerCleanup({
        name: 'chatwoot-config',
        run: async () => {
            await rm(canaryConfigPath);
        },
    });

    const canaryConfig = getCanaryViteConfig(BASE_CONFIG_SPECIFIER, {
        additionalFileExtensions: [VUE_FILE_EXTENSION],
    });
    await outputFile(canaryConfigPath, `${canaryConfig}\n`);
};

export const chatwootTarget: CanaryTarget = {
    id: TARGET_ID,
    repository: {
        name: 'chatwoot/chatwoot',
        branch: 'develop',
    },
    getDefaultRoot: () => path.resolve(ROOT, '../chatwoot'),
    getPhases: () => [createChatwootPhase()],
    install: installChatwoot,
    preflight: preflightChatwoot,
    setup: setupChatwoot,
};
