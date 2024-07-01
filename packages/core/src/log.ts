// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import c from 'chalk';

import type { LogLevel } from './types';

export type Logger = (text: any, type?: LogLevel) => void;

const log = (text: any, level: LogLevel, type: LogLevel = 'debug', name?: string) => {
    // By default (debug) we print dimmed.
    let color = c.dim;
    // eslint-disable-next-line no-console
    let logFn = console.log;

    if (type === 'error') {
        color = c.red;
        // eslint-disable-next-line no-console
        logFn = console.error;
    } else if (type === 'warn') {
        color = c.yellow;
        // eslint-disable-next-line no-console
        logFn = console.warn;
    } else if (type === 'info') {
        color = c.cyan;
        // eslint-disable-next-line no-console
        logFn = console.log;
    }

    const prefix = name ? `[${type}|${name}] ` : '';

    if (
        level === 'debug' ||
        (level === 'info' && ['info', 'error', 'warn'].includes(type)) ||
        (level === 'warn' && ['error', 'warn'].includes(type)) ||
        (level === 'error' && type === 'error')
    ) {
        const content = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
        logFn(`${color(prefix)}${content}`);
    }
};

export const getLogger =
    (level: LogLevel = 'warn', name?: string): Logger =>
    (text: any, type: LogLevel = 'debug') =>
        log(text, level, type, name);
