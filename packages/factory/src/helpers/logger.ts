// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getSendLog } from '@dd/core/helpers/log';
import { cleanPluginName } from '@dd/core/helpers/plugins';
import { formatDuration } from '@dd/core/helpers/strings';
import type {
    GetLogger,
    GlobalData,
    GlobalStores,
    LogLevel,
    LogOptions,
    TimeLog,
    TimeLogger,
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
    return name.split(NAME_SEP).map(cleanPluginName).join(NAME_SEP);
};

type LogFn = (text: any, type?: LogLevel, opts?: LogOptions) => void;

export const getLogFn = (
    name: string,
    data: GlobalData,
    stores: GlobalStores,
    logLevel: LogLevel,
): LogFn => {
    // Will remove any "datadog-" prefix and "-plugin" suffix in the name string.
    const cleanedName = cleanName(name);
    return (text, type = 'debug', { forward } = {}) => {
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

        const buildName = data.metadata?.name ? `${data.metadata.name}|` : '';
        const prefix = `[${buildName}${type}|${data.bundler.fullName}|${cleanedName}]`;

        // Keep a trace of the log in the build report.
        const content = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
        stores.logs.push({
            bundler: data.bundler.fullName,
            pluginName: name,
            type,
            message: content,
            time: Date.now(),
        });

        if (type === 'error') {
            stores.errors.push(content);
        }
        if (type === 'warn') {
            stores.warnings.push(content);
        }

        if (forward) {
            const forwardLog = async () => {
                try {
                    const sendLog = getSendLog(data);
                    await sendLog({ message: content, context: { plugin: name, status: type } });
                } catch (e) {
                    // Log the error using the parent logger.
                    const subLogger = getLogFn(name, data, stores, logLevel);
                    subLogger(`Error forwarding log: ${e}`, 'debug');
                }
            };
            stores.queue.push(forwardLog());
        }

        // Only log if the log level is high enough.
        if (logPriority[type] >= logPriority[logLevel]) {
            logFn(`${color(prefix)} ${content}`);
        }
    };
};

export const getTimeLogger = (
    name: string,
    store: GlobalStores['timings'],
    log: LogFn,
): TimeLog => {
    return (label, opts = {}) => {
        const { level = 'debug', start = true, log: toLog = true, tags = [] } = opts;
        const timer: Timer = {
            pluginName: name,
            label,
            spans: [],
            tags: [...tags, `plugin:${name}`, `level:${level}`],
            logLevel: level,
            total: 0,
        };

        // Add it to the build report.
        store.push(timer);

        const getUncompleteSpans = () => timer.spans.filter((span) => !span.end);

        // Push a new span.
        const resume: TimeLogger['resume'] = (startTime?: number) => {
            // Ignore if there is already an ongoing span.
            const uncompleteSpans = getUncompleteSpans();
            if (uncompleteSpans.length) {
                return;
            }

            // Log the start if it's the first span.
            if (!timer.spans.length && toLog) {
                log(c.dim(`[${c.cyan(label)}] : start`), 'debug');
            }

            // Add the new span.
            timer.spans.push({
                start: startTime || Date.now(),
                tags: [`plugin:${name}`],
            });
        };

        // Complete all the uncompleted spans.
        const pause: TimeLogger['pause'] = (pauseTime?: number, warn: boolean = true) => {
            const uncompleteSpans = getUncompleteSpans();

            if (!uncompleteSpans?.length) {
                if (warn) {
                    log(`Timer ${c.cyan(label)} cannot be paused, no ongoing span.`, 'debug');
                }
                return;
            }

            if (uncompleteSpans.length > 1) {
                log(`Timer ${c.cyan(label)} has more than one ongoing span.`, 'debug');
            }

            for (const span of uncompleteSpans) {
                span.end = pauseTime || Date.now();
            }
        };

        // End the timer and add it to the build report.
        const end: TimeLogger['end'] = (endTime?: number) => {
            // We don't want to log a warning if the timer is already paused.
            pause(endTime, false);
            // Compute the total duration.
            const duration = timer.spans.reduce((acc, span) => acc + (span.end! - span.start), 0);
            timer.total = duration;
            if (toLog) {
                log(`[${c.cyan(label)}] : ${c.cyan(formatDuration(duration))}`, level);
            }
        };

        // Add a tag to the timer or the ongoing spans.
        const tag: TimeLogger['tag'] = (tagsToAdd, tagOpts = {}) => {
            const { span = false } = tagOpts;
            if (span) {
                const uncompleteSpans = getUncompleteSpans();
                for (const uncompleteSpan of uncompleteSpans) {
                    uncompleteSpan.tags.push(...tagsToAdd);
                }
            } else {
                timer.tags.push(...tagsToAdd);
            }
        };

        // Auto start the timer.
        if (start) {
            let param: number | undefined;
            if (typeof start === 'number') {
                param = start;
            }
            resume(param);
        }

        const timeLogger: TimeLogger = {
            timer,
            resume,
            end,
            pause,
            tag,
        };

        return timeLogger;
    };
};

export const getLoggerFactory =
    (data: GlobalData, stores: GlobalStores, logLevel: LogLevel = 'warn'): GetLogger =>
    (name) => {
        const log = getLogFn(name, data, stores, logLevel);
        return {
            getLogger: (subName: string) => {
                const logger = getLoggerFactory(data, stores, logLevel);
                return logger(`${cleanName(name)}${NAME_SEP}${subName}`);
            },
            time: getTimeLogger(name, stores.timings, log),
            error: (text: any, opts?: LogOptions) => log(text, 'error', opts),
            warn: (text: any, opts?: LogOptions) => log(text, 'warn', opts),
            info: (text: any, opts?: LogOptions) => log(text, 'info', opts),
            debug: (text: any, opts?: LogOptions) => log(text, 'debug', opts),
        };
    };
