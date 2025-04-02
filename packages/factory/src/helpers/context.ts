// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ALL_ENVS } from '@dd/core/constants';
import type {
    BuildReport,
    BundlerFullName,
    BundlerName,
    Env,
    FactoryMeta,
    GlobalContext,
    OptionsWithDefaults,
} from '@dd/core/types';

import { getLoggerFactory } from './logger';

export const getContext = ({
    options,
    bundlerName,
    bundlerVersion,
    version,
}: {
    options: OptionsWithDefaults;
    bundlerName: BundlerName;
    bundlerVersion: string;
    version: FactoryMeta['version'];
}): GlobalContext => {
    const cwd = process.cwd();
    const variant = bundlerName === 'webpack' ? bundlerVersion.split('.')[0] : '';
    const build: BuildReport = {
        errors: [],
        warnings: [],
        logs: [],
        timings: [],
        bundler: {
            name: bundlerName,
            fullName: `${bundlerName}${variant}` as BundlerFullName,
            variant,
            version: bundlerVersion,
        },
    };

    // Use "production" if there is no env passed.
    const passedEnv: Env = (process.env.BUILD_PLUGINS_ENV as Env) || 'production';
    // Fallback to "development" if the passed env is wrong.
    const env: Env = ALL_ENVS.includes(passedEnv) ? passedEnv : 'development';
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
        env,
        getLogger: getLoggerFactory(build, options.logLevel),
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
        sendLog: () => {
            throw new Error('SendLog function called before it was initialized.');
        },
        plugins: [],
        start: Date.now(),
        version,
    };

    return context;
};
