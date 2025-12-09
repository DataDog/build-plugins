// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GetPlugins, Options } from '@dd/core/types';
import chalk from 'chalk';
import path from 'path';

import { createArchive } from './archive';
import { collectAssets } from './assets';
import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { AppsOptions, AppsOptionsWithDefaults } from './types';
import { uploadArchive } from './upload';

export { CONFIG_KEY, PLUGIN_NAME };

const yellow = chalk.yellow.bold;
const red = chalk.red.bold;

export type types = {
    // Add the types you'd like to expose here.
    AppsOptions: AppsOptions;
};

// Deal with validation and defaults here.
export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;
    const validatedOptions: AppsOptionsWithDefaults = {
        // By using an empty object, we consider the plugin as enabled.
        enable: resolvedOptions.enable ?? !!options[CONFIG_KEY],
        include: resolvedOptions.include || [],
        dryRun: resolvedOptions.dryRun ?? false,
    };
    return validatedOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    const validatedOptions = validateOptions(options);

    // If the plugin is not enabled, return an empty array.
    if (!validatedOptions.enable) {
        return [];
    }

    const handleUpload = async () => {
        const handleTimer = log.time('handle assets');
        let archiveDir: string | undefined;
        try {
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
            const { errors, warnings } = await uploadArchive(
                archive,
                validatedOptions,
                {
                    apiKey: context.auth.apiKey,
                    bundlerName: context.bundler.name,
                    site: context.auth.site,
                    version: context.version,
                },
                log,
            );
            uploadTimer.end();

            if (warnings.length > 0) {
                log.warn(
                    `${yellow('Warnings while uploading assets:')}\n    - ${warnings.join('\n    - ')}`,
                );
            }

            if (errors.length > 0) {
                const listOfErrors = errors
                    .map((error) => error.cause || error.stack || error.message || error)
                    .join('\n    - ');
                log.error(`${red('Failed to upload assets:')}\n    - ${listOfErrors}`);
            }
        } catch (error: any) {
            log.error(`${red('Failed to upload assets:')} ${error?.message || error}`);
        } finally {
            // Clean temporary directory
            if (archiveDir) {
                await rm(archiveDir);
            }
            handleTimer.end();
        }
    };

    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            async buildReport() {
                await handleUpload();
            },
        },
    ];
};
