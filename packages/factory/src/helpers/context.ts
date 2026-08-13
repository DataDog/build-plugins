// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getSendLog } from '@dd/core/helpers/log';
import type {
    BuildReport,
    GlobalContext,
    GlobalData,
    GlobalStores,
    OptionsWithDefaults,
} from '@dd/core/types';

import { getLoggerFactory } from './logger';

export const getContext = ({
    start,
    options,
    data,
    stores,
}: {
    start: number;
    options: OptionsWithDefaults;
    data: GlobalData;
    stores: GlobalStores;
}): GlobalContext => {
    const buildRoot = process.cwd();
    const build: BuildReport = {
        errors: stores.errors,
        warnings: stores.warnings,
        logs: stores.logs,
        metadata: data.metadata,
        timings: stores.timings,
        bundler: data.bundler,
    };
    const context: GlobalContext = {
        // This will be updated in the metrics plugin on initialization.
        addMetric: () => {
            throw new Error('AddMetric function called before it was initialized.');
        },
        artifactsPending: false,
        artifactsReady: Promise.resolve(),
        auth: options.auth,
        pluginNames: [],
        bundler: {
            ...build.bundler,
            // This will be updated in the bundler-report plugin once we have the configuration.
            outDir: buildRoot,
        },
        build,
        // This will be updated in the bundler-report plugin once we have the configuration.
        buildRoot,
        env: data.env,
        getLogger: getLoggerFactory(data, stores, options.logLevel),
        // This will be updated in the injection plugin on initialization.
        asyncHook: () => {
            throw new Error('AsyncHook function called before it was initialized.');
        },
        hook: () => {
            throw new Error('Hook function called before it was initialized.');
        },
        // This will be updated in the injection plugin on initialization.
        inject: () => {
            throw new Error('Inject function called before it was initialized.');
        },
        markArtifactsPending: () => {},
        markArtifactsReady: () => {},
        plugins: [],
        // This will be updated in the async-queue plugin on initialization.
        queue: () => {
            throw new Error('Queue function called before it was initialized.');
        },
        sendLog: getSendLog(data),
        start,
        version: data.version,
    };

    let resolveArtifacts: (() => void) | undefined;
    let rejectArtifacts: ((error: unknown) => void) | undefined;

    context.markArtifactsPending = () => {
        if (resolveArtifacts || rejectArtifacts) {
            return;
        }

        context.artifactsReady = new Promise<void>((resolve, reject) => {
            resolveArtifacts = resolve;
            rejectArtifacts = reject;
        });
        context.artifactsPending = true;
        context.artifactsReady.catch(() => undefined);
    };

    context.markArtifactsReady = (error?: unknown) => {
        const resolve = resolveArtifacts;
        const reject = rejectArtifacts;
        resolveArtifacts = undefined;
        rejectArtifacts = undefined;
        context.artifactsPending = false;

        if (error === undefined) {
            resolve?.();
        } else {
            reject?.(error);
        }
    };

    return context;
};
