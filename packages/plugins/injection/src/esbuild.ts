// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { getEsbuildEntries } from '@dd/core/helpers/bundlers';
import { outputFile } from '@dd/core/helpers/fs';
import { getAbsolutePath } from '@dd/core/helpers/paths';
import type { Logger, PluginOptions, GlobalContext, ResolvedEntry } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { PLUGIN_NAME } from './constants';
import {
    getContentToInject,
    isNodeSystemError,
    isFileSupported,
    warnUnsupportedFile,
} from './helpers';
import type { ContentsToInject } from './types';

const fsp = fs.promises;

export const getEsbuildPlugin = (
    log: Logger,
    context: GlobalContext,
    contentsToInject: ContentsToInject,
): PluginOptions['esbuild'] => ({
    setup(build) {
        const { onStart, onResolve, onLoad, onEnd, esbuild, initialOptions } = build;
        const entries: ResolvedEntry[] = [];
        // Use a narrower identifier to avoid cross build collisions.
        const id = context.bundler.name;
        const filePath = `${id}.${InjectPosition.MIDDLE}.${INJECTED_FILE}.js`;
        const tmpDir = fs.realpathSync(os.tmpdir());
        const absoluteFilePath = path.resolve(tmpDir, filePath);
        const injectionRx = new RegExp(`${filePath}$`);

        // InjectPosition.MIDDLE
        // Inject the file in the build using the "inject" option.
        // NOTE: This is made "safer" for sub-builds by actually creating the file.
        const initialInject = initialOptions.inject;
        initialOptions.inject = initialInject ? [...initialInject] : [];
        initialOptions.inject.push(absoluteFilePath);

        onStart(async () => {
            // Get all the entry points for later reference.
            entries.push(...(await getEsbuildEntries(build, context, log)));

            // Remove our injected file from the config, so we reduce our chances to leak our changes.
            build.initialOptions.inject = initialInject;

            try {
                // Create the MIDDLE file because esbuild will crash if it doesn't exist.
                // It seems to load entries outside of the onLoad hook once.
                await outputFile(absoluteFilePath, '');
            } catch (e: any) {
                log.error(`Could not create the files: ${e.message}`);
            }
        });

        onResolve(
            {
                filter: injectionRx,
            },
            async (args) => {
                // Mark the file as being injected by us.
                return { path: args.path, namespace: PLUGIN_NAME };
            },
        );

        onLoad(
            {
                filter: injectionRx,
                namespace: PLUGIN_NAME,
            },
            async () => {
                const content = getContentToInject(contentsToInject, {
                    position: InjectPosition.MIDDLE,
                });

                return {
                    // We can't use an empty string otherwise esbuild will crash.
                    contents: content || ' ',
                    // Resolve the imports from the project's root.
                    resolveDir: context.buildRoot,
                    loader: 'js',
                };
            },
        );

        // InjectPosition.START and InjectPosition.END
        onEnd(async (result) => {
            if (!result.metafile) {
                log.warn('Missing metafile from build result.');
                return;
            }

            const bannerForEntries = getContentToInject(contentsToInject, {
                position: InjectPosition.BEFORE,
            });
            const footerForEntries = getContentToInject(contentsToInject, {
                position: InjectPosition.AFTER,
            });
            const bannerForAllChunks = getContentToInject(contentsToInject, {
                position: InjectPosition.BEFORE,
                onAllChunks: true,
            });
            const footerForAllChunks = getContentToInject(contentsToInject, {
                position: InjectPosition.AFTER,
                onAllChunks: true,
            });

            if (
                !bannerForEntries &&
                !footerForEntries &&
                !bannerForAllChunks &&
                !footerForAllChunks
            ) {
                // Nothing to inject.
                return;
            }

            const proms: Promise<void>[] = [];

            // Process all output files
            for (const [p, o] of Object.entries(result.metafile.outputs)) {
                // Determine if this is an entry point
                const isEntry =
                    o.entryPoint && entries.some((e) => e.resolved.endsWith(o.entryPoint!));

                // Get the appropriate banner and footer
                const banner = isEntry ? bannerForEntries : bannerForAllChunks;
                const footer = isEntry ? footerForEntries : footerForAllChunks;

                // Skip if nothing to inject for this chunk type
                if (!banner && !footer) {
                    continue;
                }

                const absolutePath = getAbsolutePath(context.buildRoot, p);
                const { base, ext } = path.parse(absolutePath);

                // Check if file type is supported
                if (!isFileSupported(ext)) {
                    warnUnsupportedFile(log, ext, base);
                    continue;
                }

                // Inject content
                proms.push(
                    (async () => {
                        try {
                            const source = await fsp.readFile(absolutePath, 'utf-8');
                            const data = await esbuild.transform(source, {
                                loader: 'default',
                                banner,
                                footer,
                            });

                            // FIXME: Handle sourcemaps.
                            await fsp.writeFile(absolutePath, data.code);
                        } catch (e) {
                            if (isNodeSystemError(e) && e.code === 'ENOENT') {
                                // When we are using sub-builds, the entry file of sub-builds may not exist
                                // Hence we should skip the file injection in this case.
                                log.warn(`Could not inject content in ${absolutePath}: ${e}`);
                            } else {
                                throw e;
                            }
                        }
                    })(),
                );
            }

            await Promise.all(proms);
        });
    },
});
