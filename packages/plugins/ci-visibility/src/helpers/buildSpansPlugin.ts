// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, PluginName, PluginOptions } from '@dd/core/types';

export const BUILD_SPANS_PLUGIN_NAME: PluginName = 'datadog-ci-visibility-build-spans-plugin';

export const getBuildSpansPlugin = (context: GlobalContext): PluginOptions => {
    const log = context.getLogger(BUILD_SPANS_PLUGIN_NAME);

    const timeTotal = log.time('Total time', { start: context.start });
    const timeInit = log.time('Plugin initialization', { start: context.start });
    const timeBuild = log.time('Build', { start: false });
    const timeWrite = log.time('Write', { start: false });
    const timeLoad = log.time('Load', { start: false });
    const timeTransform = log.time('Transform', { start: false });

    let lastTransformTime = context.start;
    let lastWriteTime = context.start;

    return {
        name: BUILD_SPANS_PLUGIN_NAME,
        enforce: 'pre',
        buildStart() {
            timeInit.end();
            timeBuild.resume();
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
