// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getEsbuildEntries } from '@dd/core/helpers';
import type {
    Logger,
    ToInjectItem,
    PluginOptions,
    GlobalContext,
    ResolvedEntry,
} from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import { getAbsolutePath } from '@dd/internal-build-report-plugin/helpers';
import fsp from 'fs/promises';

import { addInjections, createFiles, getContentToInject } from './helpers';
import type { ContentsToInject, FilesToInject } from './types';

export const getEsbuildPlugin = (
    log: Logger,
    context: GlobalContext,
    toInject: Map<string, ToInjectItem>,
    contentsToInject: ContentsToInject,
    getFilesToInject: () => FilesToInject,
): PluginOptions['esbuild'] => ({
    setup(build) {
        const { onStart, onEnd, esbuild, initialOptions } = build;
        const entries: ResolvedEntry[] = [];

        onStart(async () => {
            // Prepare the injections.
            await addInjections(log, toInject, contentsToInject);

            // Get all the entry points for later reference.
            entries.push(...(await getEsbuildEntries(build)));

            // Create injection files to avoid any resolution errors.
            try {
                await createFiles(log, getFilesToInject);
            } catch (e: any) {
                log.error(`Could not create the files: ${e.message}`);
            }
        });

        const filesToInject = getFilesToInject();

        // InjectPosition.MIDDLE
        // Inject the file in the build using the "inject" option.
        // NOTE: This is made "safer" for sub-builds by actually creating the file.
        initialOptions.inject = initialOptions.inject || [];
        initialOptions.inject.push(filesToInject[InjectPosition.MIDDLE].absolutePath);

        // InjectPosition.START and InjectPosition.END
        onEnd(async (result) => {
            if (!result.metafile) {
                log.warn('Missing metafile from build result.');
                return;
            }

            const banner = getContentToInject(contentsToInject[InjectPosition.BEFORE]);
            const footer = getContentToInject(contentsToInject[InjectPosition.AFTER]);

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

            const proms = outputs.map(async (output) => {
                const source = await fsp.readFile(output, 'utf-8');
                const data = await esbuild.transform(source, {
                    loader: 'default',
                    banner,
                    footer,
                });
                await fsp.writeFile(output, data.code);
            });

            await Promise.all(proms);
        });
    },
});
