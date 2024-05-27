// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import c from 'chalk';

import type { LogLevel } from './types';

const log = (text: string, level: LogLevel, type: LogLevel = 'debug', name?: string) => {
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
        logFn(`${prefix}${color(text)}`);
    }
};

export const getLogFn =
    (level: LogLevel = 'warn', name?: string) =>
    (text: string, type: LogLevel = 'debug') =>
        log(text, level, type, name);
