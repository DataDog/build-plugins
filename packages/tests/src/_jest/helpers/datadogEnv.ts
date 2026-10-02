// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { OVERRIDE_VARIABLES } from '@dd/core/helpers/env';

export const ENV_OVERRIDE_VARIABLES = OVERRIDE_VARIABLES.flatMap(
    (key) => [`DATADOG_${key}`, `DD_${key}`] as const,
);

export const clearDatadogEnv = () => {
    const previousEnv = new Map<string, string | undefined>();
    for (const key of ENV_OVERRIDE_VARIABLES) {
        previousEnv.set(key, process.env[key]);
        delete process.env[key];
    }

    return () => {
        for (const [key, value] of previousEnv) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    };
};
