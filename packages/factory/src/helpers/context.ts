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
    const cwd = process.cwd();
    const build: BuildReport = {
        errors: stores.errors,
        warnings: stores.warnings,
        logs: stores.logs,
        metadata: data.metadata,
        timings: stores.timings,
        bundler: data.bundler,
    };
    const context: GlobalContext = {
        auth: options.auth,
        pluginNames: [],
        bundler: {
            ...build.bundler,
            // This will be updated in the bundler-report plugin once we have the configuration.
            outDir: cwd,
        },
        build,
        // This will be updated in the bundler-report plugin once we have the configuration.
        cwd,
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
        plugins: [],
        sendLog: getSendLog(data),
        start,
        version: data.version,
    };

    return context;
};
