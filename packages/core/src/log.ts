// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import c from 'chalk';

import type { LogLevel } from './types';

const log = (text: any, level: LogLevel, type: LogLevel = 'debug', name?: string) => {
    let color = c;
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
    }

    const prefix = name ? `[${c.bold(name)}] ` : '';

    if (
        level === 'debug' ||
        (level === 'warn' && ['error', 'warn'].includes(type)) ||
        (level === 'error' && type === 'error')
    ) {
        const content = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
        logFn(`${prefix}${color(content)}`);
    }
};

export type Logger = (text: any, type?: LogLevel) => void;

export const getLogger =
    (level: LogLevel = 'warn', name?: string): Logger =>
    (text: any, type: LogLevel = 'debug') =>
        log(text, level, type, name);
