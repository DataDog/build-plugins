// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ENV_VAR_REQUESTED_BUNDLERS, FULL_NAME_BUNDLERS } from '@dd/core/constants';
import type { BundlerFullName } from '@dd/core/types';
import { yellow } from '@dd/tools/helpers';

const getBundlerNameFromProject = (projectName: string) => {
    return projectName.split(' | ')[1] as BundlerFullName;
};

// Parse and detect all the --project arguments to get the requested bundlers.
export const getRequestedBundlers = (
    baseBundlers: readonly BundlerFullName[] = FULL_NAME_BUNDLERS,
): BundlerFullName[] => {
    if (process.env[ENV_VAR_REQUESTED_BUNDLERS]) {
        return process.env[ENV_VAR_REQUESTED_BUNDLERS].split(',') as BundlerFullName[];
    }

    const requestedBundlers: Set<BundlerFullName> = new Set();
    let capture = false;

    for (const arg of process.argv) {
        let bundlerName: BundlerFullName;
        if (arg === '--project') {
            // Capture the next argument as the bundler name.
            capture = true;
            continue;
        }

        if (capture === true) {
            // Capture pass.
            bundlerName = getBundlerNameFromProject(arg.trim());
            capture = false;
        } else if (arg.startsWith('--project=')) {
            // Argument is already in the format --project=...
            bundlerName = getBundlerNameFromProject(arg.split('=')[1].trim());
        } else {
            continue;
        }

        if (baseBundlers.includes(bundlerName) && FULL_NAME_BUNDLERS.includes(bundlerName)) {
            requestedBundlers.add(bundlerName);
        } else {
            console.warn(yellow(`Bundler "${bundlerName}" is not available.`));
        }
    }

    const requestBundlers: BundlerFullName[] = requestedBundlers.size
        ? Array.from(requestedBundlers)
        : [...baseBundlers];

    return requestBundlers;
};
