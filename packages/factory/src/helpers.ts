// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ALL_ENVS } from '@dd/core/constants';
import { formatDuration } from '@dd/core/helpers/strings';
import type {
    BuildReport,
    BundlerFullName,
    BundlerName,
    Env,
    FactoryMeta,
    GetLogger,
    GlobalContext,
    LogLevel,
    Options,
    OptionsWithDefaults,
    TimeLog,
    Timer,
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

        const time: TimeLog = (label, opts = {}) => {
            const { level = 'debug', start = true, log: toLog = true } = opts;
            const timer: Timer = {
                pluginName: cleanedName,
                label,
                spans: [],
                logLevel: level,
                total: 0,
            };

            // Push a new span.
            const resume = () => {
                // Log the start if it's the first span.
                if (!timer.spans.length && toLog) {
                    log(c.dim(`[${c.cyan(label)}] : start`), 'debug');
                }
                timer.spans.push({ start: Date.now() });
            };

            // Complete all the uncompleted spans.
            const pause = () => {
                const uncompleteSpans = timer.spans.filter((span) => !span.end);

                if (!uncompleteSpans?.length) {
                    log(`Timer ${c.cyan(label)} cannot be paused, no ongoing span.`, 'debug');
                    return;
                }

                if (uncompleteSpans.length > 1) {
                    log(`Timer ${c.cyan(label)} has more than one ongoing span.`, 'debug');
                }

                for (const span of uncompleteSpans) {
                    span.end = Date.now();
                }
            };

            // End the timer and add it to the build report.
            const end = () => {
                pause();
                const duration = [...timer.spans.map((span) => span.end! - span.start)].reduce(
                    (acc, curr) => acc + curr,
                    0,
                );
                timer.total = duration;
                if (toLog) {
                    log(`[${c.cyan(label)}] : ${c.cyan(formatDuration(duration))}`, level);
                }

                // Add it to the build report.
                build.timings.push(timer);
            };

            // Auto start the timer.
            if (start) {
                resume();
            }

            return {
                resume,
                end,
                pause,
            };
        };

        return {
            getLogger: (subName: string) => {
                const logger = getLoggerFactory(build, logLevel);
                return logger(`${cleanedName}${NAME_SEP}${subName}`);
            },
            time,
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

export const validateOptions = (options: Options = {}): OptionsWithDefaults => {
    return {
        auth: {},
        disableGit: false,
        logLevel: 'warn',
        ...options,
    };
};
