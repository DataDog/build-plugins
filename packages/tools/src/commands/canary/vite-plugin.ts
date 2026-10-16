// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { mkdir, rm } from '@dd/core/helpers/fs';
import os from 'os';
import { outdent } from 'outdent';
import path from 'path';

import { assertJavaScriptSyntax } from './assertions/javascript';
import { assertLiveDebuggerArtifacts } from './assertions/live-debugger';
import { getTargetCommandEnvironment } from './environment';
import type { JsonObject } from './files';
import { isJsonObject, readJsonObject } from './files';
import { CanaryCommandError, runCheckedCommand } from './runner';
import type { CanaryVariant, CommandSpec, TargetSetupContext } from './types';

export const VITE_PACKAGE = '@datadog/vite-plugin';
const VITE_PACKAGE_JSON = 'packages/published/vite-plugin/package.json';
const LIVE_DEBUGGER_PEER_DEPENDENCIES = ['@babel/parser', '@babel/traverse', '@babel/types'];
const LIVE_DEBUGGER_ENV = 'BUILD_PLUGIN_LIVE_DEBUGGER';
const NAMED_ONLY_ENV = 'BUILD_PLUGIN_LIVE_DEBUGGER_NAMED_ONLY';

// Wraps a target's own Vite config and adds the Datadog plugin, so the target's
// config file stays untouched.
export const getCanaryViteConfig = (baseConfigSpecifier: string): string => {
    return outdent`
        import { datadogVitePlugin } from '${VITE_PACKAGE}';
        import { defineConfig, mergeConfig } from 'vite';

        import baseConfig from '${baseConfigSpecifier}';

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

export const hasDependency = (packageJson: JsonObject, name: string): boolean => {
    return ['dependencies', 'devDependencies'].some((field) => {
        const dependencies = packageJson[field];
        return isJsonObject(dependencies) && name in dependencies;
    });
};

// Only Live Debugger settings differ between a target's builds.
export const getViteBuildEnvironment = (
    variant: CanaryVariant,
): Record<string, string | undefined> => {
    const targetEnvironment = getTargetCommandEnvironment(process.env);
    return {
        ...targetEnvironment,
        [LIVE_DEBUGGER_ENV]: variant === 'control' ? 'false' : 'true',
        [NAMED_ONLY_ENV]: variant === 'named-only' ? 'true' : 'false',
    };
};

export const assertViteArtifacts = async (
    filePaths: string[],
    variant: CanaryVariant,
): Promise<void> => {
    await assertJavaScriptSyntax(filePaths);
    await assertLiveDebuggerArtifacts(filePaths, variant);
};

// Packs the local Vite plugin and returns the package specifiers a target
// installs: the tarball and the Live Debugger Babel peer dependencies at their
// declared ranges.
export const packVitePlugin = async (
    { buildPluginsRoot, registerCleanup, runCommand }: TargetSetupContext,
    targetId: string,
): Promise<string[]> => {
    const tmpDirectory = os.tmpdir();
    const packDirectory = path.resolve(
        tmpDirectory,
        `build-plugins-canary-${targetId}-${process.pid}-${Date.now()}`,
    );
    // A unique tarball path keeps the target's package manager from reusing a
    // cached copy from a previous run.
    const tarballPath = path.resolve(packDirectory, 'datadog-vite-plugin.tgz');

    registerCleanup({
        name: 'vite-plugin-tarball',
        run: async () => {
            await rm(packDirectory);
        },
    });
    await mkdir(packDirectory);

    // Packing applies publishConfig, so the target resolves the built files
    // without modifying the build-plugins checkout.
    const packSpec: CommandSpec = {
        command: 'yarn',
        args: ['workspace', VITE_PACKAGE, 'pack', '--out', tarballPath],
        cwd: buildPluginsRoot,
        label: `pack ${VITE_PACKAGE}`,
    };
    await runCheckedCommand(runCommand, packSpec);

    const vitePackageJsonPath = path.resolve(buildPluginsRoot, VITE_PACKAGE_JSON);
    const vitePackageJson = await readJsonObject(vitePackageJsonPath);
    const peerDependencies = getPeerDependencySpecifiers(vitePackageJson);
    return [`${VITE_PACKAGE}@file:${tarballPath}`, ...peerDependencies];
};
