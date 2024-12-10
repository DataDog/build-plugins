// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, GetPlugins, Logger } from '@dd/core/types';

import { uploadSourcemaps } from './sourcemaps';
import type { OptionsWithRum, RumOptions, RumOptionsWithSourcemaps } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export type types = {
    // Add the types you'd like to expose here.
    RumOptions: RumOptions;
    OptionsWithRum: OptionsWithRum;
};

export const getPlugins: GetPlugins<OptionsWithRum> = (
    opts: OptionsWithRum,
    context: GlobalContext,
    log: Logger,
) => {
    // Verify configuration.
<<<<<<< HEAD
    const rumOptions = validateOptions(opts, log);
=======
    const options = validateOptions(opts, log);

    if (options.sdk) {
        // Inject the SDK from the CDN.
        context.inject({
            type: 'file',
            position: InjectPosition.BEFORE,
            value: 'https://www.datadoghq-browser-agent.com/us1/v5/datadog-rum.js',
        });

        if (options.react) {
            // Inject the rum-react-plugin.
            // NOTE: These files are built from "@dd/tools/rollupConfig.mjs" and available in the distributed package.
            context.inject({
                type: 'file',
                position: InjectPosition.MIDDLE,
                value: path.join(__dirname, './rum-react-plugin.js'),
            });
        }

        context.inject({
            type: 'code',
            position: InjectPosition.MIDDLE,
            value: getInjectionValue(options as RumOptionsWithSdk, context),
        });
    }

>>>>>>> 2aae126 (createBrowserRouter auto instrumentation)
    return [
        {
            name: 'datadog-rum-sourcemaps-plugin',
            enforce: 'post',
            async writeBundle() {
                if (rumOptions.disabled) {
                    return;
                }

                if (rumOptions.sourcemaps) {
                    // Need the "as" because Typescript doesn't understand that we've already checked for sourcemaps.
                    await uploadSourcemaps(rumOptions as RumOptionsWithSourcemaps, context, log);
                }
            },
            transform(code) {
                let updatedCode = code;
                const createBrowserRouterImportRegExp = new RegExp(
                    /(import \{.*)createBrowserRouter[,]?(.*\} from "react-router-dom")/g,
                );
                const hasCreateBrowserRouterImport =
                    code.match(createBrowserRouterImportRegExp) !== null;

                if (hasCreateBrowserRouterImport) {
                    // Remove the import of createBrowserRouter
                    updatedCode = updatedCode.replace(
                        createBrowserRouterImportRegExp,
                        (_, p1, p2) => {
                            return `${p1}${p2}`;
                        },
                    );

                    // replace all occurences of `createBrowserRouter` with `DD_RUM.createBrowserRouter`
                    updatedCode = updatedCode.replace(
                        new RegExp(/createBrowserRouter/g),
                        'DD_RUM.createBrowserRouter',
                    );
                }

                return updatedCode;
            },
            transformInclude(id) {
                return (
                    // @ts-ignore
                    options?.react?.router === true &&
                    id.match(new RegExp(/.*\.(js|jsx|ts|tsx)$/)) !== null
                );
            },
        },
    ];
};
