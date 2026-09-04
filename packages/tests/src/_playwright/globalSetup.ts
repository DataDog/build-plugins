// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ENV_VAR_REQUESTED_BUNDLERS } from '@dd/core/constants';
import type { BundlerName } from '@dd/core/types';
import { PUBLIC_DIR } from '@dd/tests/_playwright/constants';
import { cleanPublicDirs } from '@dd/tests/_playwright/helpers/cleanPublicDirs';
import { getRequestedBundlers } from '@dd/tests/_playwright/helpers/requestedBundlers';
import { blue, buildPlugins, dim, green } from '@dd/tools/helpers';

// TODO Also build and test for ESM.
export const setupPlaywrightTests = async (publicDir: string) => {
    const getPfx = (name: string) => `[${blue(name)}] `;
    const getSubPfx = (name: string) => `  ${dim(getPfx(name))}`;
    const globalPfx = getPfx('Global Setup');
    console.time(globalPfx);
    const requestedBundlers = getRequestedBundlers();
    // Save the requested bundlers in the env.
    process.env[ENV_VAR_REQUESTED_BUNDLERS] = requestedBundlers.join(',');
    console.log(`${globalPfx}Setting up tests.`);

    // In the CI we're building before the job starts.
    // No need to do it here.
    if (!process.env.CI) {
        // Build the requested bundler plugins.
        const buildPluginsPfx = getSubPfx('Build Plugins');
        console.time(buildPluginsPfx);
        console.log(`${buildPluginsPfx}Building ${green(requestedBundlers.join(', '))} plugins...`);
        buildPlugins(requestedBundlers as BundlerName[]);
        console.timeEnd(buildPluginsPfx);
    }

    // Delete public dirs.
    const cleanPfx = getSubPfx('Clean');
    console.time(cleanPfx);
    await cleanPublicDirs(publicDir);
    console.timeEnd(cleanPfx);

    console.timeEnd(globalPfx);
};

const globalSetup = () => setupPlaywrightTests(PUBLIC_DIR);

export default globalSetup;
