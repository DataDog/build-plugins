// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { isInjectionFile } from '@dd/core/helpers';
import type { GlobalContext } from '@dd/core/types';
import path from 'path';

// Will match any last part of a path after a dot or slash and is a word character.
const EXTENSION_RX = /\.(?!.*(?:\.|\/|\\))(\w{1,})/g;

// Will match any type of query characters.
// "?" or "%3F" (url encoded "?") or "|"
const QUERY_RX = /(\?|%3F|\|)+/gi;

const getExtension = (filepath: string) => {
    // Reset RX first.
    EXTENSION_RX.lastIndex = 0;
    return EXTENSION_RX.exec(filepath)?.[1];
};

export const getType = (name: string): string => {
    if (name === 'unknown') {
        return name;
    }

    if (name.includes('webpack/runtime')) {
        return 'runtime';
    }

    return getExtension(cleanPath(name)) || 'unknown';
};

const BUNDLER_SPECIFICS = ['unknown', 'commonjsHelpers.js', 'vite/preload-helper.js'];
// Make list of paths unique, remove the current file and particularities.
export const cleanReport = <T = string>(
    report: Set<string>,
    filepath: string,
    filter?: (p: string) => T,
) => {
    const cleanedReport: Set<T> = new Set();
    for (const reportFilepath of report) {
        const cleanedPath = cleanPath(reportFilepath);
        if (
            // Don't add injections.
            isInjectionFile(reportFilepath) ||
            // Don't add itself into it.
            cleanedPath === filepath ||
            // Remove common specific files injected by bundlers.
            BUNDLER_SPECIFICS.includes(cleanedPath)
        ) {
            continue;
        }

        if (filter) {
            const filteredValue = filter(cleanedPath);
            if (filteredValue) {
                cleanedReport.add(filteredValue);
            }
        } else {
            cleanedReport.add(cleanedPath as unknown as T);
        }
    }
    return cleanedReport;
};

// Clean a path from its query parameters and leading invisible characters.
// Careful with this and webpack/rspack as loaders may add "|" before and after the filepath.
export const cleanPath = (filepath: string) => {
    return (
        filepath
            // [webpack] Only keep the loaded part of a loader query.
            .split('!')
            .pop()!
            // Remove query parameters.
            .split(QUERY_RX)
            .shift()!
            // Remove leading, invisible characters,
            // sometimes added in rollup by the commonjs plugin.
            .replace(/^[^\w\s.,!@#$%^&*()=+~`\-/]+/, '')
    );
};

// Will only prepend the cwd if not already there.
export const getAbsolutePath = (cwd: string, filepath: string) => {
    if (isInjectionFile(filepath)) {
        return INJECTED_FILE;
    }

    if (filepath.startsWith(cwd)) {
        return filepath;
    }
    return path.resolve(cwd, filepath);
};

// Extract a name from a path based on the context (out dir and cwd).
export const cleanName = (context: GlobalContext, filepath: string) => {
    if (isInjectionFile(filepath)) {
        return INJECTED_FILE;
    }

    if (filepath === 'unknown') {
        return filepath;
    }

    if (filepath.includes('webpack/runtime')) {
        return filepath.replace('webpack/runtime/', '').replace(/ +/g, '-');
    }

    return (
        filepath
            // [webpack] Only keep the loaded part of a loader query.
            .split('!')
            .pop()!
            // Remove outDir's path.
            .replace(context.bundler.outDir, '')
            // Remove the cwd's path.
            .replace(context.cwd, '')
            // Remove node_modules path.
            .split('node_modules')
            .pop()!
            // Remove query parameters.
            .split(QUERY_RX)
            .shift()!
            // Remove leading slashes.
            .replace(/^\/+/, '')
    );
};
