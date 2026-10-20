// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, outputFile, rm } from '@dd/core/helpers/fs';
import { ROOT } from '@dd/tools/constants';
import path from 'path';

import { assertLiveDebuggerBuildOutput } from '../assertions/live-debugger';
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

const TARGET_ID = 'mastodon';
const MASTODON_PACKAGE_NAME = '@mastodon/mastodon';
const MASTODON_PACKAGE_JSON = 'package.json';
const MASTODON_LOCKFILE = 'yarn.lock';
const MASTODON_DEPENDENCIES = 'node_modules';
const APP_CONFIG = 'vite.config.mts';
const BASE_CONFIG_SPECIFIER = `./${APP_CONFIG}`;
const CANARY_CONFIG = 'vite.config.live-debugger-canary.mjs';
const CANARY_OUTPUT_DIRECTORY = 'build/live-debugger-canary';
const JAVASCRIPT_PATTERNS = ['**/*.js'];
const PHASE_ID = 'app';

// Mastodon's Vite config sets `root` to app/javascript, and Vite resolves a
// relative --outDir against that root, so the build gets an absolute path.
const getOutputDirectory = (root: string, variant: CanaryVariant): string => {
    return path.resolve(root, CANARY_OUTPUT_DIRECTORY, PHASE_ID, variant);
};

const getArtifactSpec = (root: string, variant: CanaryVariant): ArtifactSpec => {
    const outputDirectory = getOutputDirectory(root, variant);
    return {
        roots: [outputDirectory],
        patterns: JAVASCRIPT_PATTERNS,
    };
};

const getBuildCommand = (root: string, variant: CanaryVariant): CommandSpec => {
    const outputDirectory = getOutputDirectory(root, variant);
    return {
        command: 'yarn',
        args: [
            'build:production',
            '--config',
            CANARY_CONFIG,
            '--outDir',
            outputDirectory,
            '--emptyOutDir',
        ],
        cwd: root,
        env: getViteBuildEnvironment(variant),
        label: `${PHASE_ID} ${variant} build`,
    };
};

export const createMastodonPhase = (): CanaryPhase => {
    return {
        id: PHASE_ID,
        buildTool: 'vite',
        localPackages: [VITE_PACKAGE],
        getArtifactSpec,
        getBuildCommand,
        assertBuildOutput: assertLiveDebuggerBuildOutput,
        assertArtifacts: assertViteArtifacts,
    };
};

const installMastodon = async ({ root, runCommand }: TargetSetupContext): Promise<void> => {
    const targetEnvironment = getTargetCommandEnvironment(process.env);
    const installSpec: CommandSpec = {
        command: 'yarn',
        args: ['install', '--immutable'],
        cwd: root,
        env: targetEnvironment,
        label: 'install Mastodon dependencies',
    };
    await runCheckedCommand(runCommand, installSpec);
};

const preflightMastodon = async ({ root }: TargetSetupContext): Promise<void> => {
    const packageJsonPath = path.resolve(root, MASTODON_PACKAGE_JSON);
    const appConfigPath = path.resolve(root, APP_CONFIG);
    const packageJson = existsSync(packageJsonPath)
        ? await readJsonObject(packageJsonPath)
        : undefined;
    if (packageJson?.name !== MASTODON_PACKAGE_NAME || !existsSync(appConfigPath)) {
        throw new CanaryCommandError(
            `${root} does not look like a Mastodon checkout. Pass its path with --root.`,
        );
    }

    const dependenciesPath = path.resolve(root, MASTODON_DEPENDENCIES);
    if (!existsSync(dependenciesPath)) {
        throw new CanaryCommandError(
            'Mastodon dependencies are not installed. Run "yarn install --immutable" in its checkout first, or pass --install.',
        );
    }

    if (hasDependency(packageJson, VITE_PACKAGE)) {
        throw new CanaryCommandError(
            `Mastodon already depends on ${VITE_PACKAGE}. Remove it before running the canary.`,
        );
    }

    const canaryConfigPath = path.resolve(root, CANARY_CONFIG);
    if (existsSync(canaryConfigPath)) {
        throw new CanaryCommandError(
            `${canaryConfigPath} already exists. Remove it before running the canary.`,
        );
    }
};

const setupMastodon = async (context: TargetSetupContext): Promise<void> => {
    const { registerCleanup, root, runCommand } = context;
    const packageJsonPath = path.resolve(root, MASTODON_PACKAGE_JSON);
    const lockfilePath = path.resolve(root, MASTODON_LOCKFILE);
    const dependencySnapshots = await readFiles([packageJsonPath, lockfilePath]);
    const targetEnvironment = getTargetCommandEnvironment(process.env);
    const packageSpecifiers = await packVitePlugin(context, TARGET_ID);

    registerCleanup({
        name: 'mastodon-dependencies',
        run: async () => {
            await restoreSnapshots(dependencySnapshots);
            const installSpec: CommandSpec = {
                command: 'yarn',
                args: ['install', '--immutable'],
                cwd: root,
                env: targetEnvironment,
                label: 'restore Mastodon dependency state',
            };
            await runCheckedCommand(runCommand, installSpec);
        },
    });

    const addSpec: CommandSpec = {
        command: 'yarn',
        args: ['add', '--dev', ...packageSpecifiers],
        cwd: root,
        env: targetEnvironment,
        label: `install local ${VITE_PACKAGE} into Mastodon`,
    };
    await runCheckedCommand(runCommand, addSpec);

    const canaryConfigPath = path.resolve(root, CANARY_CONFIG);
    registerCleanup({
        name: 'mastodon-config',
        run: async () => {
            await rm(canaryConfigPath);
        },
    });

    const canaryConfig = getCanaryViteConfig(BASE_CONFIG_SPECIFIER);
    await outputFile(canaryConfigPath, `${canaryConfig}\n`);
};

export const mastodonTarget: CanaryTarget = {
    id: TARGET_ID,
    repository: {
        name: 'mastodon/mastodon',
        branch: 'main',
    },
    getDefaultRoot: () => path.resolve(ROOT, '../mastodon'),
    getPhases: () => [createMastodonPhase()],
    install: installMastodon,
    preflight: preflightMastodon,
    setup: setupMastodon,
};
