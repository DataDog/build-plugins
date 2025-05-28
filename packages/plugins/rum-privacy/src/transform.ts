import type {
    InstrumentationInput,
    InstrumentationOptions,
} from '@datadog/js-instrumentation-wasm';
import { instrument } from '@datadog/js-instrumentation-wasm';

import { PRIVACY_HELPERS_MODULE_ID } from './constants';
import type { PluginOptions } from './options';

interface TransformOptions {
    module: 'CJS' | 'ESM' | undefined;
    jsx: boolean | undefined;
    typescript: boolean | undefined;

    addToDictionaryHelper: string;
    helpersModule: string;
    transformStrategy: 'ast' | undefined;
}

export interface TransformOutput {
    code: string;
    map?: string;
}

const pluginModuleOptionToTransformModuleOption: {
    [_module in PluginOptions['module']]: TransformOptions['module'];
} = {
    cjs: 'CJS',
    esm: 'ESM',
    unknown: undefined,
};

export function buildTransformOptions(pluginOptions: PluginOptions): TransformOptions {
    return {
        module: pluginModuleOptionToTransformModuleOption[pluginOptions.module],
        jsx: pluginOptions.jsx,
        transformStrategy: pluginOptions.transformStrategy,
        typescript: pluginOptions.typescript,

        addToDictionaryHelper: '$',
        helpersModule: PRIVACY_HELPERS_MODULE_ID,
    };
}

export async function transformCode(
    code: string,
    id: string,
    options: TransformOptions,
): Promise<TransformOutput> {
    return instrument({ id, code } as InstrumentationInput, options as InstrumentationOptions);
}
