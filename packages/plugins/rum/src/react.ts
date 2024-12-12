// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions } from '@dd/core/types';

export const getReactPlugin = (): PluginOptions => {
    return {
        name: 'datadog-rum-react-plugin',
        transform(code) {
            let updatedCode = code;
            const createBrowserRouterImportRegExp = new RegExp(
                /(import \{.*)createBrowserRouter[,]?(.*\} from "react-router-dom")/g,
            );
            const hasCreateBrowserRouterImport =
                code.match(createBrowserRouterImportRegExp) !== null;

            if (hasCreateBrowserRouterImport) {
                // Remove the import of createBrowserRouter
                updatedCode = updatedCode.replace(createBrowserRouterImportRegExp, (_, p1, p2) => {
                    return `${p1}${p2}`;
                });

                // replace all occurences of `createBrowserRouter` with `DD_RUM.createBrowserRouter`
                updatedCode = updatedCode.replace(
                    new RegExp(/createBrowserRouter/g),
                    'DD_RUM.createBrowserRouter',
                );
            }

            return updatedCode;
        },
        transformInclude(id) {
            return id.match(new RegExp(/.*\.(js|jsx|ts|tsx)$/)) !== null;
        },
    };
};
