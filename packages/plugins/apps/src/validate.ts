// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import type { AppsOptions, AppsOptionsWithDefaults, AppsParameterSchema } from './types';

const PARAMETER_TYPES: Record<AppsParameterSchema['type'], string> = {
    STRING: 'string',
    NUMBER: 'number',
    BOOLEAN: 'boolean',
};
const RESERVED_PARAMETER_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

const isValidDefault = ({ type, defaultValue }: AppsParameterSchema): boolean => {
    switch (type) {
        case 'STRING':
            return typeof defaultValue === 'string';
        case 'NUMBER':
            return typeof defaultValue === 'number' && Number.isFinite(defaultValue);
        case 'BOOLEAN':
            return typeof defaultValue === 'boolean';
        default:
            return false;
    }
};

/**
 * Checks the declaration before it reaches an upload, so a mistake fails the
 * build with a readable message rather than being rejected by Datadog.
 */
export const resolveParameters = (
    parameters: AppsOptions['parameters'],
): AppsParameterSchema[] | undefined => {
    if (parameters === undefined) {
        return undefined;
    }
    const schema = parameters?.schema;
    if (!Array.isArray(schema)) {
        throw new Error(
            'apps.parameters must be the value returned by defineDatadogAppParameters().',
        );
    }
    const names = new Set<string>();
    return schema.map((parameter: AppsParameterSchema) => {
        const { name, type, enum: options } = parameter;
        const where = `apps.parameters "${String(name)}"`;
        if (typeof name !== 'string' || name.trim() === '' || RESERVED_PARAMETER_NAMES.has(name)) {
            throw new Error(`${where} needs a non-empty, non-reserved name.`);
        }
        if (names.has(name)) {
            throw new Error(`${where} is declared more than once.`);
        }
        names.add(name);
        if (!(type in PARAMETER_TYPES)) {
            throw new Error(`${where} must be of type STRING, NUMBER, or BOOLEAN.`);
        }
        if (!isValidDefault(parameter)) {
            throw new Error(`${where} needs a ${PARAMETER_TYPES[type]} default.`);
        }
        if (options !== undefined) {
            const isValidEnum =
                type === 'STRING' &&
                Array.isArray(options) &&
                options.length > 0 &&
                options.every((option) => typeof option === 'string') &&
                new Set(options).size === options.length &&
                options.includes(parameter.defaultValue as string);
            if (!isValidEnum) {
                throw new Error(
                    `${where} options must be unique strings that include its default.`,
                );
            }
        }
        return {
            name,
            type,
            defaultValue: parameter.defaultValue,
            ...(parameter.label === undefined ? {} : { label: parameter.label }),
            ...(parameter.description === undefined ? {} : { description: parameter.description }),
            ...(options === undefined ? {} : { enum: [...options] }),
        };
    });
};

export const resolveLongPolling = (
    longPolling: AppsOptions['longPolling'],
): AppsOptionsWithDefaults['longPolling'] => {
    const maxRetries = longPolling?.maxRetries ?? 10;
    const timeoutMs = longPolling?.timeoutMs ?? 40_000;

    if (!Number.isInteger(maxRetries) || maxRetries < 1) {
        throw new Error('apps.longPolling.maxRetries must be an integer >= 1.');
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('apps.longPolling.timeoutMs must be a positive number.');
    }

    return {
        maxRetries,
        timeoutMs,
        jitter: longPolling?.jitter ?? true,
        exponentialBackoff: longPolling?.exponentialBackoff ?? true,
    };
};

export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;

    return {
        include: resolvedOptions.include || [],
        // Passed through as configured; the authored tag source cleans it, best effort.
        tags: resolvedOptions.tags,
        longPolling: resolveLongPolling(resolvedOptions.longPolling),
        parameters: resolveParameters(resolvedOptions.parameters),
    };
};
