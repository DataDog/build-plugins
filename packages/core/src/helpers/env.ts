// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import chalk from 'chalk';

import type { Logger } from '../types';

const green = chalk.bold.green;
const yellow = chalk.bold.yellow;

// All the variables that can be overriden, listed for easier code search:
//   - DD_API_KEY
//   - DATADOG_API_KEY
//   - DD_APP_KEY
//   - DATADOG_APP_KEY
//   - DD_SOURCEMAP_INTAKE_URL
//   - DATADOG_SOURCEMAP_INTAKE_URL
//   - DD_LOGS_INTAKE_URL
//   - DATADOG_LOGS_INTAKE_URL
//   - DD_SITE
//   - DATADOG_SITE
const OVERRIDE_VARIABLES = [
    'API_KEY',
    'APP_KEY',
    'LOGS_INTAKE_URL',
    'SOURCEMAP_INTAKE_URL',
    'SITE',
] as const;
type ENV_KEY = (typeof OVERRIDE_VARIABLES)[number];

// Return the environment variable that would be prefixed with either DATADOG_ or DD_.
export const getDDEnvValue = (key: ENV_KEY) => {
    return process.env[`DATADOG_${key}`] || process.env[`DD_${key}`];
};

// Returns the keys that are defined in the environment.
export const getUsedKey = (key: ENV_KEY) => {
    const usedKeys: string[] = [];
    if (process.env[`DD_${key}`]) {
        usedKeys.push(`DD_${key}`);
    }
    if (process.env[`DATADOG_${key}`]) {
        usedKeys.push(`DATADOG_${key}`);
    }
    return usedKeys;
};

// Keep track of which configurations are overriden by the environment.
export const notifyOnEnvOverrides = (log: Logger) => {
    const overridenValues: string[] = [];

    for (const value of OVERRIDE_VARIABLES) {
        const usedKeys = getUsedKey(value);

        if (
            usedKeys.length > 1 &&
            !usedKeys.every((k) => process.env[k] === process.env[usedKeys[0]])
        ) {
            // Notify if more than one is defined, and that they are different.
            // Resulting in a conflict, given getDDEnvValue() we resolve with DATADOG_${value}.
            const keys = usedKeys.map((k) => yellow(k)).join(' and ');
            const usedKey = yellow(`DATADOG_${value}`);
            log.warn(`Conflicting keys ${keys}, will use ${usedKey}`);
            overridenValues.push(`${keys} (using ${usedKey})`);
        } else if (usedKeys.length) {
            // Key is used with no conflicts.
            const keys = usedKeys.map((k) => green(k)).join(' and ');
            overridenValues.push(`${keys} (same value)`);
        }
    }

    if (overridenValues.length) {
        log.info(`Overrides from environment:\n  - ${overridenValues.join('\n  - ')}`);
    }
};
