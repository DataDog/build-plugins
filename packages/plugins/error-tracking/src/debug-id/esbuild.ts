// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAbsolutePath } from '@dd/core/helpers/paths';
import type { GlobalContext, Logger, PluginOptions } from '@dd/core/types';
import fsp from 'fs/promises';
import path from 'path';

import { SUPPORTED_EXTENSIONS } from './constants';
import { getSnippet, stringToUUID } from './utils';

export const getDebugIdEsbuildPlugin = (
    log: Logger,
    context: GlobalContext,
    debugIds: Map<string, string>,
): PluginOptions['esbuild'] => ({
    setup(build) {
        build.initialOptions.metafile = true;

        build.onEnd(async (result) => {
            if (!result.metafile) {
                log.warn('Missing metafile — debug_id injection skipped.');
                return;
            }

            const proms: Promise<void>[] = [];

            for (const [p] of Object.entries(result.metafile.outputs)) {
                const absolutePath = getAbsolutePath(context.buildRoot, p);

                if (!SUPPORTED_EXTENSIONS.has(path.extname(absolutePath))) {
                    continue;
                }

                proms.push(
                    (async () => {
                        const source = await fsp.readFile(absolutePath, 'utf-8');
                        const uuid = stringToUUID(source);
                        debugIds.set(absolutePath, uuid);
                        await fsp.writeFile(absolutePath, `${getSnippet(uuid)}\n${source}`);
                    })(),
                );
            }

            await Promise.all(proms);
        });
    },
});
