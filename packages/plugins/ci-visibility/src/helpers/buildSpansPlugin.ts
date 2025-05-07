// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { shouldGetGitInfo } from '@dd/core/helpers/plugins';
import type { GlobalContext, Options, PluginName, PluginOptions } from '@dd/core/types';
import { PLUGIN_NAME as BUILD_REPORT_PLUGIN_NAME } from '@dd/internal-build-report-plugin';

export const BUILD_SPANS_PLUGIN_NAME: PluginName = 'datadog-ci-visibility-build-spans-plugin';

export const getBuildSpansPlugin = (context: GlobalContext, options: Options): PluginOptions => {
    const log = context.getLogger(BUILD_SPANS_PLUGIN_NAME);

    const timeBuildReport = log.time('Build report', { start: false });
    const timeGit = log.time('Git', { start: false });
    const timeHold = log.time('Hold', { start: context.start });
    const timeTotal = log.time('Total time', { start: context.start });
    const timeInit = log.time('Datadog plugins initialization', { start: context.start });
    const timeBuild = log.time('Build', { start: false });
    const timeWrite = log.time('Write', { start: false });
    const timeLoad = log.time('Load', { start: false });
    const timeTransform = log.time('Transform', { start: false });

    let lastTransformTime = context.start;
    let lastWriteTime = context.start;

    return {
        name: BUILD_SPANS_PLUGIN_NAME,
        enforce: 'pre',
        init() {
            timeInit.end();
        },
        buildStart() {
            timeHold.end();
            timeBuild.resume();
            if (shouldGetGitInfo(options)) {
                timeGit.resume();
            }
        },
        git() {
            timeGit.end();
        },
        loadInclude() {
            return true;
        },
        load() {
            timeLoad.resume();
            return null;
        },
        transformInclude() {
            return true;
        },
        transform() {
            timeTransform.resume();
            lastTransformTime = Date.now();
            return null;
        },
        buildEnd() {
            timeLoad.end();
            timeTransform.end();
            timeBuild.end();
            timeWrite.resume();
        },
        writeBundle() {
            lastWriteTime = Date.now();
        },
        buildReport() {
            for (const timing of context.build.timings) {
                if (
                    timing.pluginName !== BUILD_REPORT_PLUGIN_NAME ||
                    timing.label !== 'build report'
                ) {
                    continue;
                }

                // Copy build report spans to our own logger.
                for (const span of timing.spans) {
                    const end = span.end || Date.now();
                    timeBuildReport.resume(span.start);
                    timeBuildReport.pause(end);
                }
            }
        },
        asyncTrueEnd() {
            // esbuild may not call buildEnd in time to define the write phase.
            // So lets simulate this from the last transform time.
            // This is a bit of a hack, but it's better than nothing.
            if (context.bundler.fullName === 'esbuild') {
                if (!timeWrite.timer.spans.length) {
                    timeWrite.resume(lastTransformTime);
                }
            }
        },
        syncTrueEnd() {
            timeWrite.end(lastWriteTime);
            timeTotal.end();
        },
    };
};
