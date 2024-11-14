// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    BundlerFullName,
    BundlerName,
    FactoryMeta,
    GlobalContext,
    Options,
    ToInjectItem,
} from '@dd/core/types';

export const getContext = ({
    auth,
    bundlerName,
    bundlerVersion,
    injections,
    version,
}: {
    auth: Options['auth'];
    bundlerName: BundlerName;
    bundlerVersion: string;
    injections: ToInjectItem[];
    version: FactoryMeta['version'];
}): GlobalContext => {
    const cwd = process.cwd();
    const variant = bundlerName === 'webpack' ? bundlerVersion.split('.')[0] : '';

    const context: GlobalContext = {
        auth,
        pluginNames: [],
        bundler: {
            name: bundlerName,
            fullName: `${bundlerName}${variant}` as BundlerFullName,
            variant,
            outDir: cwd,
            version: bundlerVersion,
        },
        build: {
            errors: [],
            warnings: [],
        },
        cwd,
        inject: (item: ToInjectItem) => {
            injections.push(item);
        },
        start: Date.now(),
        version,
    };

    return context;
};
