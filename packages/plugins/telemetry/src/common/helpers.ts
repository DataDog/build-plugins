// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile } from 'fs-extra';

import { CONFIG_KEY } from '../constants';
import type {
    OptionsDD,
    Metric,
    MetricToSend,
    TelemetryOptions,
    OptionsWithTelemetry,
    Module,
    Compilation,
    ValueContext,
} from '../types';

import { defaultFilters } from './filters';

export const validateOptions = (options: OptionsWithTelemetry): TelemetryOptions => {
    const validatedOptions: TelemetryOptions = options[CONFIG_KEY] || { disabled: false };
    return validatedOptions;
};

export const getMetric = (metric: Metric, opts: OptionsDD): MetricToSend => ({
    type: 'gauge',
    tags: [...metric.tags, ...opts.tags],
    metric: `${opts.prefix ? `${opts.prefix}.` : ''}${metric.metric}`,
    points: [[opts.timestamp, metric.value]],
});

export const getOptionsDD = (options: TelemetryOptions): OptionsDD => {
    return {
        timestamp: Math.floor((options.timestamp || Date.now()) / 1000),
        tags: options.tags || [],
        prefix: options.prefix || '',
        filters: options.filters || defaultFilters,
    };
};

export const getPluginName = (opts: string | { name: string }) =>
    typeof opts === 'string' ? opts : opts.name;

// We want to ensure cwd ends with a slash.
const formatCwd = (cwd: string = ''): string => {
    return cwd.endsWith('/') ? cwd : `${cwd}/`;
};

// Format a module name by trimming the user's specific part out.
export const getDisplayName = (name: string, cwd?: string) => {
    let toReturn: string = name;
    const nameSplit: string[] = name.split(formatCwd(cwd));
    if (cwd && nameSplit.length) {
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
        .replace(formatCwd(context), './');

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

// Format the loader's name by extracting it from the query.
// "[...]/node_modules/babel-loader/lib/index.js" => babel-loader
const formatLoaderName = (loader: string) =>
    loader.replace(/^.*\/node_modules\/(@[a-z0-9][\w-.]+\/[a-z0-9][\w-.]*|[^/]+).*$/, '$1');

// Find a module's loaders names and format them.
export const getLoaderNames = (module: Module) =>
    (module.loaders || []).map((l: any) => l.loader || l).map(formatLoaderName);

// Make it so if JSON.stringify fails it rejects the promise and not the whole process.
export const writeFile = (filePath: string, content: any) => {
    return new Promise((resolve) => {
        return outputFile(filePath, JSON.stringify(content, null, 4)).then(resolve);
    });
};

export const getValueContext = (args: any[]): ValueContext[] => {
    return args.map((arg) => ({
        type: arg?.constructor?.name ?? typeof arg,
        name: arg?.name,
        value: typeof arg === 'string' ? arg : undefined,
    }));
};
