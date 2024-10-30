// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options, PluginOptions, ToInjectItem } from '@dd/core/types';
import { getBuildReportPlugin } from '@dd/internal-build-report-plugin';
import { getBundlerReportPlugin } from '@dd/internal-bundler-report-plugin';
import { getGitPlugin } from '@dd/internal-git-plugin';
import { getInjectionPlugins } from '@dd/internal-injection-plugin';

export const getInternalPlugins = (
    options: Options,
    bundler: any,
    context: GlobalContext,
    injections: ToInjectItem[],
): PluginOptions[] => {
    const bundlerReportPlugin = getBundlerReportPlugin(options, context);
    const buildReportPlugin = getBuildReportPlugin(options, context);
    const gitPlugin = getGitPlugin(options, context);
    const injectionPlugins = getInjectionPlugins(bundler, options, context, injections);

    return [bundlerReportPlugin, buildReportPlugin, gitPlugin, ...injectionPlugins];
};
