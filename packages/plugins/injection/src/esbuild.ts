// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { getEsbuildEntries } from '@dd/core/helpers/bundlers';
import { outputFile } from '@dd/core/helpers/fs';
import { getAbsolutePath, getUniqueId } from '@dd/core/helpers';
import type { Logger, PluginOptions, GlobalContext, ResolvedEntry } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { PLUGIN_NAME } from './constants';
import { getContentToInject } from './helpers';
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
        const filePath = `${getUniqueId()}.${InjectPosition.MIDDLE}.${INJECTED_FILE}.js`;
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
                const content = getContentToInject(contentsToInject[InjectPosition.MIDDLE]);

                return {
                    // We can't use an empty string otherwise esbuild will crash.
                    contents: content || ' ',
                    // Resolve the imports from the project's root.
                    resolveDir: context.cwd,
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

            const banner = getContentToInject(contentsToInject[InjectPosition.BEFORE]);
            const footer = getContentToInject(contentsToInject[InjectPosition.AFTER]);

            if (!banner && !footer) {
                // Nothing to inject.
                return;
            }

            // Rewrite outputs with the injected content.
            // Only keep the entry files.
            const outputs: string[] = Object.entries(result.metafile.outputs)
                .map(([p, o]) => {
                    const entryPoint = o.entryPoint;
                    if (!entryPoint) {
                        return;
                    }

                    const entry = entries.find((e) => e.resolved.endsWith(entryPoint));
                    if (!entry) {
                        return;
                    }

                    return getAbsolutePath(context.cwd, p);
                })
                .filter(Boolean) as string[];

            // Write the content.
            const proms = outputs.map(async (output) => {
                const source = await fsp.readFile(output, 'utf-8');
                const data = await esbuild.transform(source, {
                    loader: 'default',
                    banner,
                    footer,
                });

                // FIXME: Handle sourcemaps.
                await fsp.writeFile(output, data.code);
            });

            await Promise.all(proms);
        });
    },
});
