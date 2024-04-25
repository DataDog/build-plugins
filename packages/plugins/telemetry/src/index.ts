import type { GetPlugins } from '@datadog/build-plugins-core/types';

import { PLUGIN_NAME } from './constants';
import { getEsbuildPlugin } from './esbuild-plugin';
import type { OptionsWithTelemetryEnabled } from './types';
import { getWebpackPlugin } from './webpack-plugin';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export const getPlugins: GetPlugins<OptionsWithTelemetryEnabled> = (
    opt: OptionsWithTelemetryEnabled,
) => {
    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            esbuild: getEsbuildPlugin(opt),
            webpack: getWebpackPlugin(opt),
        },
    ];
};
