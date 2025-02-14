// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    BuildReport,
    BundlerFullName,
    BundlerName,
    FactoryMeta,
    GetLogger,
    GlobalContext,
    LogLevel,
    Options,
    OptionsWithDefaults,
} from '@dd/core/types';
import c from 'chalk';

const logPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    none: 4,
};

// Which separator to use for plugin names.
export const NAME_SEP = '>';

const cleanName = (name: string) => {
    return name
        .split(NAME_SEP)
        .map((st) => st.replace(/^datadog-|-plugin$/g, ''))
        .join(NAME_SEP);
};

export const getLoggerFactory =
    (build: BuildReport, logLevel: LogLevel = 'warn'): GetLogger =>
    (name) => {
        // Will remove any "datadog-" prefix and "-plugin" suffix in the name string.
        const cleanedName = cleanName(name);
        const log = (text: any, type: LogLevel = 'debug') => {
            // By default (debug) we print dimmed.
            let color = c.dim;
            let logFn = console.log;

            if (type === 'error') {
                color = c.red;
                logFn = console.error;
            } else if (type === 'warn') {
                color = c.yellow;
                logFn = console.warn;
            } else if (type === 'info') {
                color = c.cyan;
                logFn = console.log;
            }

            const prefix = `[${type}|${build.bundler.fullName}|${cleanedName}]`;

            // Keep a trace of the log in the build report.
            const content = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
            build.logs.push({
                bundler: build.bundler.fullName,
                pluginName: cleanedName,
                type,
                message: content,
                time: Date.now(),
            });

            if (type === 'error') {
                build.errors.push(content);
            }
            if (type === 'warn') {
                build.warnings.push(content);
            }

            // Only log if the log level is high enough.
            if (logPriority[type] >= logPriority[logLevel]) {
                logFn(`${color(prefix)} ${content}`);
            }
        };

        return {
            getLogger: (subName: string) => {
                const logger = getLoggerFactory(build, logLevel);
                return logger(`${cleanedName}${NAME_SEP}${subName}`);
            },
            error: (text: any) => log(text, 'error'),
            warn: (text: any) => log(text, 'warn'),
            info: (text: any) => log(text, 'info'),
            debug: (text: any) => log(text, 'debug'),
        };
    };

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
        bundler: {
            name: bundlerName,
            fullName: `${bundlerName}${variant}` as BundlerFullName,
            variant,
            version: bundlerVersion,
        },
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
        getLogger: getLoggerFactory(build, options.logLevel),
        // This will be updated in the injection plugin on initialization.
        inject: () => {
            throw new Error('Inject function called before it was initialized.');
        },
        start: Date.now(),
        version,
    };

    return context;
};

export const validateOptions = (options: Options = {}): OptionsWithDefaults => {
    return {
        auth: {},
        disableGit: false,
        logLevel: 'warn',
        ...options,
    };
};
