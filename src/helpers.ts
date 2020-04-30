// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const getPluginName = (opts: string | { name: string }) =>
    typeof opts === 'string' ? opts : opts.name;

// Format a module name by trimming the user's specific part out.
export const getDisplayName = (name: string, context: string) =>
    name
        .split(context!)
        .pop()!
        // Remove loaders query
        .split('!')
        .pop()!
        // Remove everything in front of /node_modules
        .replace(/(.*)?\/node_modules\//, '/node_modules/');

export const formatModuleName = (name: string, context: string) =>
    name
        // Remove loaders query
        .split('!')
        .pop()!
        // Webpack store its modules with a relative path
        // let's do the same so we can integrate better with it.
        .replace(context, '.');

// Find the module name and format it the same way as webpack.
interface Module {
    name?: string;
    userRequest?: string;
    issuer?: {
        userRequest: string;
    };
    _identifier?: string;
    loaders: any[];
}

export const getModuleName = (module: Module, context: string) => {
    let name = module.name || module.userRequest;
    if (!name) {
        try {
            name = module.issuer
                ? module.issuer.userRequest
                : // eslint-disable-next-line no-underscore-dangle
                  module._identifier;
        } catch (e) {
            /* We'll fallback at the end */
        }
    }
    return formatModuleName(name || 'no-name', context);
};

// Format the loader's name by extracting it from the query.
// "[...]/node_modules/babel-loader/lib/index.js" => babel-loader
export const formatLoaderName = (loader: string) =>
    loader.replace(/^.*\/node_modules\/(@[a-z0-9][\w-.]+\/[a-z0-9][\w-.]*|[^/]+).*$/, '$1');

// Find a module's loaders names and format them.
export const getLoaderNames = (module: Module) =>
    (module.loaders || []).map((l: any) => l.loader || l).map(formatLoaderName);
