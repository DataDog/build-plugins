import type { UnpluginOptions } from 'unplugin';

import { getLogger } from '../../log';
import type { GlobalContext, Options } from '../../types';

import { getEsbuildPlugin } from './esbuild';
import { getRollupPlugin } from './rollup';
import { getWebpackPlugin } from './webpack';

const PLUGIN_NAME = 'build-report';

export const getBuildReportPlugin = (opts: Options, context: GlobalContext): UnpluginOptions => {
    const log = getLogger(opts.logLevel, PLUGIN_NAME);
    return {
        name: PLUGIN_NAME,
        enforce: 'post',
        esbuild: getEsbuildPlugin(context, log),
        webpack: getWebpackPlugin(context, PLUGIN_NAME, log),
        // Vite and Rollup have the same API.
        vite: getRollupPlugin(context, log),
        rollup: getRollupPlugin(context, log),
    };
};
