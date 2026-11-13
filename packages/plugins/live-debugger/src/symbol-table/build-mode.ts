// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions } from '@dd/core/types';

export type BuildModeTracker = {
    hooks: Pick<PluginOptions, 'esbuild' | 'webpack' | 'rspack' | 'rollup' | 'vite'>;
    // False in watch mode and on dev servers. esbuild doesn't tell plugins whether it's watching,
    // so only its first build counts as a one-off build.
    isOneOffBuild: () => boolean;
};

// Track whether the build is a one-off build, as opposed to watch mode or a dev server.
export const createBuildModeTracker = (): BuildModeTracker => {
    let isContinuousBuild = false;
    let isCompilerWatching = () => false;
    let esbuildBuildCount = 0;

    return {
        hooks: {
            esbuild: {
                setup(build) {
                    // Any later build is a rebuild: in watch mode, on the dev server, or from the
                    // context API.
                    build.onStart(() => {
                        esbuildBuildCount += 1;
                        isContinuousBuild ||= esbuildBuildCount > 1;
                    });
                },
            },
            webpack(compiler) {
                isCompilerWatching = () => compiler.watchMode;
            },
            rspack(compiler) {
                isCompilerWatching = () => compiler.watchMode;
            },
            rollup: {
                buildStart() {
                    isContinuousBuild ||= this.meta.watchMode;
                },
            },
            vite: {
                configResolved(config) {
                    isContinuousBuild ||= config.command === 'serve';
                },
                buildStart() {
                    isContinuousBuild ||= this.meta.watchMode;
                },
            },
        },
        isOneOffBuild: () => !isContinuousBuild && !isCompilerWatching(),
    };
};
