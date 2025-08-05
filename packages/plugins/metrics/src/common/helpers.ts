// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { OptionsWithDefaults, ValueContext } from '@dd/core/types';
import { CONFIG_KEY } from '@dd/metrics-plugin/constants';
import type {
    Metric,
    Module,
    Compilation,
    MetricsOptionsWithDefaults,
    Filter,
} from '@dd/metrics-plugin/types';

import { defaultFilters } from './filters';

export const getTimestamp = (timestamp?: number): number => {
    return Math.floor((timestamp || Date.now()) / 1000);
};

export const validateOptions = (
    opts: OptionsWithDefaults,
    bundlerName: string,
): MetricsOptionsWithDefaults => {
    const options = opts[CONFIG_KEY];

    const timestamp = getTimestamp(options?.timestamp);

    let prefix = options?.enableStaticPrefix === false ? '' : `build.${bundlerName}`;
    if (options?.prefix) {
        prefix += prefix ? `.${options.prefix}` : options.prefix;
    }

    return {
        enable: !!opts[CONFIG_KEY],
        enableStaticPrefix: true,
        enableTracing: false,
        filters: defaultFilters,
        tags: [],
        ...opts[CONFIG_KEY],
        timestamp,
        // Make it lowercase and remove any leading/closing dots.
        prefix: prefix.toLowerCase().replace(/(^\.*|\.*$)/g, ''),
    };
};

const getMetric = (metric: Metric, defaultTags: string[], prefix: string): Metric => {
    return {
        ...metric,
        tags: [...metric.tags, ...defaultTags],
        metric: prefix ? `${prefix}.${metric.metric}` : metric.metric,
    };
};

export const getMetricsToSend = (
    metrics: Set<Metric>,
    timestamp: number,
    filters: Filter[],
    defaultTags: string[],
    prefix: string,
): Set<Metric> => {
    const metricsToSend: Set<Metric> = new Set();

    // Format metrics to be DD ready and apply filters
    for (const metric of metrics) {
        if (filters?.length) {
            let filteredMetric: Metric | null = metric;
            for (const filter of filters) {
                // If it's already been filtered out, no need to keep going.
                if (!filteredMetric) {
                    break;
                }
                filteredMetric = filter(metric);
            }
            if (filteredMetric) {
                metricsToSend.add(getMetric(filteredMetric, defaultTags, prefix));
            }
        } else {
            metricsToSend.add(getMetric(metric, defaultTags, prefix));
        }
    }

    metricsToSend.add(
        getMetric(
            {
                metric: 'metrics.count',
                type: 'count',
                points: [[timestamp, metricsToSend.size + 1]],
                tags: [],
            },
            defaultTags,
            prefix,
        ),
    );

    return metricsToSend;
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

export const getValueContext = (args: any[]): ValueContext[] => {
    return args.map((arg) => ({
        type: arg?.constructor?.name ?? typeof arg,
        name: arg?.name,
        value: typeof arg === 'string' ? arg : undefined,
    }));
};
