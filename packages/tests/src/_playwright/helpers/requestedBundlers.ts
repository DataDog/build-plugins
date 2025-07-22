// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ENV_VAR_REQUESTED_BUNDLERS, SUPPORTED_BUNDLERS } from '@dd/core/constants';
import type { BundlerName } from '@dd/core/types';
import { yellow } from '@dd/tools/helpers';

const getBundlerNameFromProject = (projectName: string) => {
    return projectName.split(' | ')[1] as BundlerName;
};

// Parse and detect all the --project arguments to get the requested bundlers.
export const getRequestedBundlers = (
    baseBundlers: readonly BundlerName[] = SUPPORTED_BUNDLERS,
): BundlerName[] => {
    if (process.env[ENV_VAR_REQUESTED_BUNDLERS]) {
        return process.env[ENV_VAR_REQUESTED_BUNDLERS].split(',') as BundlerName[];
    }

    const requestedBundlers: Set<BundlerName> = new Set();
    let capture = false;

    for (const arg of process.argv) {
        let bundlerName: BundlerName;
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

        if (baseBundlers.includes(bundlerName) && SUPPORTED_BUNDLERS.includes(bundlerName)) {
            requestedBundlers.add(bundlerName);
        } else {
            console.warn(yellow(`Bundler "${bundlerName}" is not available.`));
        }
    }

    const requestBundlers: BundlerName[] = requestedBundlers.size
        ? Array.from(requestedBundlers)
        : [...baseBundlers];

    return requestBundlers;
};
