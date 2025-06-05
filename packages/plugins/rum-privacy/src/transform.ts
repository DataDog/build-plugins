import type { InstrumentationOptions } from '@datadog/js-instrumentation-wasm';

import { PRIVACY_HELPERS_MODULE_ID } from './constants';
import type { PluginOptions } from './options';

export interface TransformOutput {
    code: string;
    map?: string;
}

export function buildTransformOptions(pluginOptions: PluginOptions): InstrumentationOptions {
    return {
        input: {
            module: pluginOptions.module,
            jsx: pluginOptions.jsx,
            typescript: pluginOptions.typescript,
        },
        privacy: {
            helpers: {
                addToDictionaryFunction: '$',
                module: PRIVACY_HELPERS_MODULE_ID,
            },
        },
    };
}
