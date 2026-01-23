// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GetPlugins } from '@dd/core/types';
import chalk from 'chalk';
import path from 'path';

import { createArchive } from './archive';
import { collectAssets } from './assets';
import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import { resolveIdentifier } from './identifier';
import type { AppsOptions } from './types';
import { uploadArchive } from './upload';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

const yellow = chalk.yellow.bold;
const red = chalk.red.bold;

export type types = {
    // Add the types you'd like to expose here.
    AppsOptions: AppsOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    let toThrow: Error | undefined;
    const validatedOptions = validateOptions(options);
    if (!validatedOptions.enable) {
        return [];
    }

    const handleUpload = async () => {
        const handleTimer = log.time('handle assets');
        let archiveDir: string | undefined;
        try {
            const identifierTimer = log.time('resolve identifier');

            // Try to get identifier and name from options first, then from resolved values
            let identifier = validatedOptions.identifier;
            let name = validatedOptions.name;

            // Only resolve if we're missing either identifier or name
            if (!identifier || !name) {
                const resolved = resolveIdentifier(context.buildRoot, log, context.git?.remote);
                identifier = identifier || resolved?.identifier;
                name = name || resolved?.name;
            }

            if (!identifier || !name) {
                throw new Error(`Missing apps identification.
Either:
  - pass an 'options.apps.identifier' and 'options.apps.name' to your plugin's configuration.
  - have a 'name' and a 'repository' in your 'package.json'.
  - have a valid remote url on your git project.
`);
            }
            identifierTimer.end();

            const relativeOutdir = path.relative(context.buildRoot, context.bundler.outDir);
            const assetGlobs = [...validatedOptions.include, `${relativeOutdir}/**/*`];

            const assets = await collectAssets(assetGlobs, context.buildRoot);

            if (!assets.length) {
                log.info(`No assets to upload.`);
                return;
            }

            const archiveTimer = log.time('archive assets');
            const archive = await createArchive(assets);
            archiveTimer.end();
            // Store variable for later disposal of directory.
            archiveDir = path.dirname(archive.archivePath);

            const uploadTimer = log.time('upload assets');
            const { errors: uploadErrors, warnings: uploadWarnings } = await uploadArchive(
                archive,
                {
                    apiKey: context.auth.apiKey,
                    bundlerName: context.bundler.name,
                    dryRun: validatedOptions.dryRun,
                    identifier,
                    name,
                    site: context.auth.site,
                    version: context.version,
                },
                log,
            );
            uploadTimer.end();

            if (uploadWarnings.length > 0) {
                log.warn(
                    `${yellow('Warnings while uploading assets:')}\n    - ${uploadWarnings.join('\n    - ')}`,
                );
            }

            if (uploadErrors.length > 0) {
                const listOfErrors = uploadErrors
                    .map((error) => error.cause || error.stack || error.message || error)
                    .join('\n    - ');
                throw new Error(`    - ${listOfErrors}`);
            }
        } catch (error: any) {
            toThrow = error;
            log.error(`${red('Failed to upload assets:')}\n${error?.message || error}`);
        }

        // Clean temporary directory
        if (archiveDir) {
            await rm(archiveDir);
        }
        handleTimer.end();

        if (toThrow) {
            // Break the build.
            throw toThrow;
        }
    };

    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            async asyncTrueEnd() {
                // Upload all the assets at the end of the build.
                await handleUpload();
            },
        },
    ];
};
