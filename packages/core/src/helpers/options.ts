// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';

const warnedKeys = new Set<string>();

/**
 * Resolve the `enable` value for a plugin config key, emitting a deprecation
 * warning when the caller passes a non-boolean truthy/falsy value.
 *
 * Semantics:
 *  - Config key absent / undefined / falsy → false (plugin disabled).
 *  - Config key is a truthy object without an `enable` property → true.
 *  - Config key is a truthy object with `enable` set → coerce to boolean,
 *    warning once per key if it isn't already a boolean.
 */
export const resolveEnable = <T extends { [K in C]?: unknown }, C extends string>(
    options: T,
    configKey: C,
    log: Logger,
): boolean => {
    const pluginConfig = options[configKey];

    if (pluginConfig && typeof pluginConfig === 'object' && 'enable' in pluginConfig) {
        const value = pluginConfig.enable;

        if (typeof value !== 'boolean' && value !== undefined) {
            if (!warnedKeys.has(configKey)) {
                warnedKeys.add(configKey);
                log.warn(
                    `\`${configKey}.enable\` should be a boolean, got ${typeof value}. ` +
                        `Non-boolean values are coerced today but will be rejected in the next major.`,
                );
            }
        }

        if (value !== undefined) {
            // TODO(next major): drop this coercion and reject non-boolean `enable`
            // outright. The warning above gives callers one major to migrate.
            return !!value;
        }
    }

    return !!pluginConfig;
};

/** @internal Exposed only for tests to reset the warn-once set between cases. */
export const resetEnableWarnings = (): void => {
    warnedKeys.clear();
};
