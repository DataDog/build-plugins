// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { mkdir, rm } from '@dd/core/helpers';
import type { BundlerFullName } from '@dd/core/types';
import { allBundlers } from '@dd/tools/bundlers';
import { dim } from '@dd/tools/helpers';
import { allPlugins, fullConfig } from '@dd/tools/plugins';
import fs from 'fs';
import path from 'path';

// Build a given project with a given bundler.
const buildProject = async (bundler: BundlerFullName, cwd: string) => {
    const plugin = allPlugins[bundler](fullConfig);
    const build = allBundlers[bundler];
    const buildConfig = build.config({
        workingDir: cwd,
        // We'll use the name of the bundler as the name of the entry file.
        // eg: For "Webpack 4" we'll have "./projects/dist/webpack4.js".
        entry: { [bundler]: './index.js' },
        outDir: path.resolve(cwd, './dist'),
        plugins: [plugin],
    });

    return build.run(buildConfig);
};

// Build a given project with a list of bundlers.
const buildProjectWithBundlers = async (projectPath: string, bundlers: BundlerFullName[]) => {
    const name = projectPath.split(path.sep).pop() || 'unknown';

    // Clean the dist folders.
    await rm(path.resolve(projectPath, 'dist'));

    // Build with all the bundlers.
    return Promise.all(
        bundlers.map(async (bundler) => {
            const buildBundlerPfx = `    [${dim(`Build ${name} with ${bundler}`)}]`;
            console.time(buildBundlerPfx);
            const { errors } = await buildProject(bundler, projectPath);
            console.timeEnd(buildBundlerPfx);
            return errors;
        }),
    );
};

// Wrapper around the buildProjectWithBundlers function.
//   - Create the destination folder.
//   - Copy the content of the source folder in it.
//   - Build the project with all the requested bundlers.
//   - Delete the folder if the build failed.
//   - Touch a "built" file if the build succeeded.
const handleBuild = async (source: string, destination: string, bundlers: BundlerFullName[]) => {
    // Create the project dir.
    await mkdir(destination);
    // Copy the content of our project in it.
    await fs.promises.cp(`${source}/`, `${destination}/`, {
        recursive: true,
        errorOnExist: true,
        force: true,
    });

    // Build it with all the requested bundlers.
    const name = destination.split(path.sep).pop() || 'unknown';
    const buildProjectPfx = `  [${dim(name)}] `;
    console.time(buildProjectPfx);
    const errors = (await buildProjectWithBundlers(destination, bundlers)).flat();

    if (errors.length) {
        console.error(`${buildProjectPfx}Build failed.`, errors);
        // Delete the folder, so other tests can try and build it.
        await rm(destination);
    } else {
        // Touch the built file so other tests know it's ready.
        await fs.promises.writeFile(`${destination}/built`, '');
    }

    console.timeEnd(buildProjectPfx);
};

// Wait for the build to be done or to fail.
// Based on the presence of the "built" file or the disparition of the project folder.
const waitForBuild = async (projectDir: string): Promise<{ built: boolean; error: boolean }> => {
    return new Promise((resolve) => {
        const builtInterval = setInterval(() => {
            if (fs.existsSync(`${projectDir}/built`)) {
                clearInterval(builtInterval);
                clearInterval(errorInterval);
                resolve({ built: true, error: false });
            }
        }, 100);

        const errorInterval = setInterval(() => {
            if (!fs.existsSync(projectDir)) {
                clearInterval(errorInterval);
                clearInterval(builtInterval);
                resolve({ built: false, error: true });
            }
        }, 100);
    });
};

// Verify if the project has been built.
// Trigger the build if it's not been done yet.
// Wait for the build to be done.
// Note: This is to be used in a beforeAll hook,
// so all the workers can use the same build of a given suite.
export const verifyProjectBuild = async (
    source: string,
    destination: string,
    bundlers: BundlerFullName[],
) => {
    // Wait a random time to avoid conflicts.
    await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 500)));

    // Verify if the build as started, by checking the presence of the public directory.
    const dirExists = fs.existsSync(destination);
    if (dirExists) {
        const result = await waitForBuild(destination);
        if (result.error) {
            await verifyProjectBuild(source, destination, bundlers);
        }
    } else {
        // Build the project.
        await handleBuild(source, destination, bundlers);
    }
};
