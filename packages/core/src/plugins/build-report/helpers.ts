// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '../../types';

export const getType = (name: string): string => {
    if (name === 'unknown') {
        return name;
    }

    if (name.includes('webpack/runtime')) {
        return 'runtime';
    }

    return name.includes('.')
        ? name
              // Only keep the extension
              .split('.')
              .pop()!
              // Remove any query parameters
              .split('?')
              .shift()!
        : 'unknown';
};

export const cleanName = (context: GlobalContext, filepath: string) => {
    if (filepath === 'unknown') {
        return filepath;
    }

    if (filepath.includes('webpack/runtime')) {
        return filepath.replace('webpack/runtime/', '').replace(/ +/g, '-');
    }

    let resolvedPath = filepath;
    try {
        resolvedPath = require.resolve(filepath);
    } catch (e) {
        // No problem, we keep the initial path.
    }

    return (
        resolvedPath
            // Remove outDir's path.
            .replace(context.bundler.outDir, '')
            // Remove the cwd's path.
            .replace(context.cwd, '')
            // Remove node_modules path.
            .split('node_modules')
            .pop()!
            // Remove query parameters.
            .split('?')
            .shift()!
            // Remove leading slashes.
            .replace(/^\/+/, '')
    );
};
