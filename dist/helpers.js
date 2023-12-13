"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
Object.defineProperty(exports, "__esModule", { value: true });
const fs_extra_1 = require("fs-extra");
exports.getPluginName = (opts) => typeof opts === 'string' ? opts : opts.name;
// We want to ensure context ends with a slash.
exports.formatContext = (context = '') => {
    return context.endsWith('/') ? context : `${context}/`;
};
// Format a module name by trimming the user's specific part out.
exports.getDisplayName = (name, context) => {
    let toReturn = name;
    const nameSplit = name.split(exports.formatContext(context));
    if (context && nameSplit.length) {
        toReturn = nameSplit.pop();
    }
    return (toReturn
        // Remove loaders query
        .split('!')
        .pop()
        // Remove everything in front of /node_modules
        .replace(/(.*)?\/node_modules\//, '/node_modules/')
        // Remove any prefixing ../
        .replace(/^((\.)*\/)+/, ''));
};
exports.formatModuleName = (name, context) => name
    // Remove loaders query
    .split('!')
    .pop()
    // Webpack store its modules with a relative path
    // let's do the same so we can integrate better with it.
    .replace(exports.formatContext(context), './');
exports.getModulePath = (module, compilation) => {
    var _a;
    let path = module.userRequest;
    if (!path) {
        let issuer;
        if (compilation.moduleGraph && typeof compilation.moduleGraph.getIssuer === 'function') {
            issuer = compilation.moduleGraph.getIssuer(module);
        }
        else {
            issuer = module.issuer;
        }
        path = issuer === null || issuer === void 0 ? void 0 : issuer.userRequest;
        if (!path) {
            // eslint-disable-next-line no-underscore-dangle
            path = (_a = module._identifier) === null || _a === void 0 ? void 0 : _a.split('!').pop();
        }
    }
    return path || 'unknown';
};
// Find the module name and format it the same way as webpack.
exports.getModuleName = (module, compilation, context) => {
    let name = module.name || module.userRequest;
    if (!name) {
        name = exports.getModulePath(module, compilation);
    }
    return exports.formatModuleName(name || 'no-name', context);
};
exports.getModuleSize = (module) => {
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
exports.formatLoaderName = (loader) => loader.replace(/^.*\/node_modules\/(@[a-z0-9][\w-.]+\/[a-z0-9][\w-.]*|[^/]+).*$/, '$1');
// Find a module's loaders names and format them.
exports.getLoaderNames = (module) => (module.loaders || []).map((l) => l.loader || l).map(exports.formatLoaderName);
// Format a duration 0h 0m 0s 0ms
exports.formatDuration = (duration) => {
    const days = Math.floor(duration / 1000 / 60 / 60 / 24);
    const usedDuration = duration - days * 24 * 60 * 60 * 1000;
    const d = new Date(usedDuration);
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const milliseconds = d.getUTCMilliseconds();
    return `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds ? `${seconds}s ` : ''}${milliseconds}ms`.trim();
};
// Make it so if JSON.stringify fails it rejects the promise and not the whole process.
exports.writeFile = (filePath, content) => {
    return new Promise((resolve) => {
        return fs_extra_1.outputFile(filePath, JSON.stringify(content, null, 4)).then(resolve);
    });
};
exports.getContext = (args) => {
    return args.map((arg) => {
        var _a, _b;
        return ({
            type: (_b = (_a = arg === null || arg === void 0 ? void 0 : arg.constructor) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : typeof arg,
            name: arg === null || arg === void 0 ? void 0 : arg.name,
            value: typeof arg === 'string' ? arg : undefined,
        });
    });
};
