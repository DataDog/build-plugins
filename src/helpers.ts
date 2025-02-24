// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile } from 'fs-extra';
import chalk from 'chalk';

import { Module, Compilation, Context } from './types';

export const showDeprecatedMessage = (bundler: 'webpack' | 'esbuild') => {
    console.warn(`
${chalk.bold.red('🔥 Deprecation warning 🔥')}
${chalk.bold.yellow('@datadog/build-plugin')} is now deprecated.

Please use ${chalk.bold.green(`@datadog/${bundler}-plugin`)} instead.
`);
};

export const getPluginName = (opts: string | { name: string }) =>
    typeof opts === 'string' ? opts : opts.name;

// We want to ensure context ends with a slash.
export const formatContext = (context: string = ''): string => {
    return context.endsWith('/') ? context : `${context}/`;
};

// Format a module name by trimming the user's specific part out.
export const getDisplayName = (name: string, context?: string) => {
    let toReturn: string = name;
    const nameSplit: string[] = name.split(formatContext(context));
    if (context && nameSplit.length) {
        toReturn = nameSplit.pop()!;
    }

    return (
        toReturn
            // Remove loaders query
            .split('!')
            .pop()!
            // Remove everything in front of /node_modules
            .replace(/(.*)?\/node_modules\//, '/node_modules/')
            // Remove any prefixing ../
            .replace(/^((\.)*\/)+/, '')
    );
};

export const formatModuleName = (name: string, context?: string) =>
    name
        // Remove loaders query
        .split('!')
        .pop()!
        // Webpack store its modules with a relative path
        // let's do the same so we can integrate better with it.
        .replace(formatContext(context), './');

export const getModulePath = (module: Module, compilation: Compilation) => {
    let path: string | undefined = module.userRequest;
    if (!path) {
        let issuer;
        if (compilation.moduleGraph && typeof compilation.moduleGraph.getIssuer === 'function') {
            issuer = compilation.moduleGraph.getIssuer(module);
        } else {
            issuer = module.issuer;
        }

        path = issuer?.userRequest;

        if (!path) {
            // eslint-disable-next-line no-underscore-dangle
            path = module._identifier?.split('!').pop();
        }
    }
    return path || 'unknown';
};

// Find the module name and format it the same way as webpack.
export const getModuleName = (module: Module, compilation: Compilation, context?: string) => {
    let name: string = module.name || module.userRequest;
    if (!name) {
        name = getModulePath(module, compilation);
    }
    return formatModuleName(name || 'no-name', context);
};

export const getModuleSize = (module: Module): number => {
    if (!module) {
        return 0;
    }

    if (typeof module.size === 'function') {
        return module.size();
    }
    return module.size;
};

// Format the loader's name by extracting it from the query.
// "[...]/node_modules/babel-loader/lib/index.js" => babel-loader
export const formatLoaderName = (loader: string) =>
    loader.replace(/^.*\/node_modules\/(@[a-z0-9][\w-.]+\/[a-z0-9][\w-.]*|[^/]+).*$/, '$1');

// Find a module's loaders names and format them.
export const getLoaderNames = (module: Module) =>
    (module.loaders || []).map((l: any) => l.loader || l).map(formatLoaderName);

// Format a duration 0h 0m 0s 0ms
export const formatDuration = (duration: number) => {
    const days = Math.floor(duration / 1000 / 60 / 60 / 24);
    const usedDuration = duration - days * 24 * 60 * 60 * 1000;
    const d = new Date(usedDuration);
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const milliseconds = d.getUTCMilliseconds();
    return `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${
        seconds ? `${seconds}s ` : ''
    }${milliseconds}ms`.trim();
};

// Make it so if JSON.stringify fails it rejects the promise and not the whole process.
export const writeFile = (filePath: string, content: any) => {
    return new Promise((resolve) => {
        return outputFile(filePath, JSON.stringify(content, null, 4)).then(resolve);
    });
};

export const getContext = (args: any[]): Context[] => {
    return args.map((arg) => ({
        type: arg?.constructor?.name ?? typeof arg,
        name: arg?.name,
        value: typeof arg === 'string' ? arg : undefined,
    }));
};
