// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Module } from './types';

export const getPluginName = (opts: string | { name: string }) =>
    typeof opts === 'string' ? opts : opts.name;

// Format a module name by trimming the user's specific part out.
export const getDisplayName = (name: string, context?: string) => {
    let toReturn = name;
    if (context && name.split(context).pop()) {
        toReturn = name.split(context).pop()!;
    }

    return (
        toReturn
            // Remove loaders query
            .split('!')
            .pop()!
            // Remove everything in front of /node_modules
            .replace(/(.*)?\/node_modules\//, '/node_modules/')
    );
};

export const formatModuleName = (name: string, context: string) =>
    name
        // Remove loaders query
        .split('!')
        .pop()!
        // Webpack store its modules with a relative path
        // let's do the same so we can integrate better with it.
        .replace(context, '.');

// Find the module name and format it the same way as webpack.
export const getModuleName = (module: Module, context: string) => {
    let name = module.name || module.userRequest;
    const issuer = module.moduleGraph ? module.moduleGraph.issuer : module.issuer;
    if (!name) {
        try {
            name = issuer
                ? issuer.userRequest
                : // eslint-disable-next-line no-underscore-dangle
                  module._identifier;
        } catch (e) {
            /* We'll fallback at the end */
        }
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
