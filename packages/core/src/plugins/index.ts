// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Meta, Options } from '../types';

import { getBuildReportPlugin } from './build-report';
import { getBundlerReportPlugin } from './bundler-report';
import { getGitPlugin } from './git';

export const getInternalPlugins = (options: Options, meta: Meta) => {
    const cwd = process.cwd();
    const variant =
        meta.framework === 'webpack' ? (meta.webpack.compiler['webpack'] ? '5' : '4') : '';

    const globalContext: GlobalContext = {
        auth: options.auth,
        bundler: {
            name: meta.framework,
            fullName: `${meta.framework}${variant}`,
            variant,
            outDir: cwd,
        },
        build: {
            errors: [],
            warnings: [],
        },
        cwd,
        start: Date.now(),
        version: meta.version,
    };

    const bundlerReportPlugin = getBundlerReportPlugin(options, globalContext);
    const buildReportPlugin = getBuildReportPlugin(options, globalContext);
    const gitPlugin = getGitPlugin(options, globalContext);

    return {
        globalContext,
        internalPlugins: [bundlerReportPlugin, buildReportPlugin, gitPlugin],
    };
};
