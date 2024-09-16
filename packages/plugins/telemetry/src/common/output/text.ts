// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration } from '@dd/core/helpers';
import type { Logger } from '@dd/core/log';
import { serializeBuildReport } from '@dd/core/plugins/build-report/helpers';
import type { Entry, GlobalContext, Output } from '@dd/core/types';
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';

import type { Report, TimingsMap } from '../../types';

// How many items do we show in the top lists.
const TOP = 5;
const numColor = chalk.bold.red;
const nameColor = chalk.bold.cyan;

type ValuesToPrint = { name: string; top: boolean; values: { name: string; value: string }[] };

type FileReport = {
    name: string;
    aggregatedSize?: number;
    size: number;
    dependencies: Set<string>;
    dependents: Set<string>;
};

// Sort a collection by attribute
const sortDesc = (attr: ((arg: any) => any) | string) => (a: any, b: any) => {
    let aVal;
    let bVal;

    if (typeof attr === 'function') {
        aVal = attr(a);
        bVal = attr(b);
    } else {
        aVal = a[attr];
        bVal = b[attr];
    }

    if (aVal > bVal) {
        return -1;
    } else if (aVal < bVal) {
        return 1;
    } else {
        return 0;
    }
};

export const getGeneralValues = (context: GlobalContext): ValuesToPrint[] => {
    const valuesToPrint: ValuesToPrint = {
        name: 'General Numbers',
        values: [],
        top: false,
    };

    const nbModules = context.build.inputs ? context.build.inputs.length : 0;
    const nbAssets = context.build.outputs ? context.build.outputs.length : 0;
    const nbWarnings = context.build.warnings.length;
    const nbErrors = context.build.errors.length;
    const nbEntries = context.build.entries ? context.build.entries.length : 0;

    if (context.build.start) {
        valuesToPrint.values.push({
            name: 'Overhead duration',
            value: formatDuration(context.build.start - context.start),
        });
    }

    if (context.build.duration) {
        valuesToPrint.values.push({
            name: 'Build duration',
            value: formatDuration(context.build.duration),
        });
    }

    if (context.build.writeDuration) {
        valuesToPrint.values.push({
            name: 'Write duration',
            value: formatDuration(context.build.writeDuration),
        });
    }

    valuesToPrint.values.push(
        {
            name: 'Number of modules',
            value: nbModules.toString(),
        },
        {
            name: 'Number of assets',
            value: nbAssets.toString(),
        },
        {
            name: 'Number of entries',
            value: nbEntries.toString(),
        },
        {
            name: 'Number of warnings',
            value: nbWarnings.toString(),
        },
        {
            name: 'Number of errors',
            value: nbErrors.toString(),
        },
    );

    return [valuesToPrint];
};

const getAssetsValues = (context: GlobalContext): ValuesToPrint[] => {
    const assetSizesToPrint: ValuesToPrint = {
        name: 'Asset size',
        values: (context.build.outputs || [])
            .sort(sortDesc((output: Output) => output.size))
            .map((output) => ({
                name: output.name,
                value: prettyBytes(output.size),
            })),
        top: true,
    };

    const entrySizesToPrint: ValuesToPrint = {
        name: 'Entry aggregated size',
        values: (context.build.entries || [])
            .sort(sortDesc((entry: Entry) => entry.size))
            .map((entry) => ({
                name: entry.name,
                value: prettyBytes(entry.size),
            })),
        top: true,
    };

    const entryModulesToPrint: ValuesToPrint = {
        name: 'Entry number of modules',
        values:
            (context.build.entries || [])
                .sort(sortDesc((entry: Entry) => entry.size))
                .map((entry) => ({
                    name: entry.name,
                    value: entry.inputs.length.toString(),
                })) || [],
        top: true,
    };

    return [assetSizesToPrint, entrySizesToPrint, entryModulesToPrint];
};

const getModulesValues = (context: GlobalContext): ValuesToPrint[] => {
    const dependentsToPrint: ValuesToPrint = {
        name: `Module total dependents`,
        values: [],
        top: true,
    };

    const dependenciesToPrint: ValuesToPrint = {
        name: `Module total dependencies`,
        values: [],
        top: true,
    };

    const sizesToPrint: ValuesToPrint = {
        name: `Module size`,
        values: [],
        top: true,
    };

    const aggregatedSizesToPrint: ValuesToPrint = {
        name: `Module aggregated size`,
        values: [],
        top: true,
    };

    const dependencies: Set<FileReport> = new Set();

    // Build our collections.
    const serializedReport = serializeBuildReport(context.build);
    const inputs: Map<string, FileReport> = new Map();
    const fileDependencies: Map<string, Set<string>> = new Map();
    const fileDependents: Map<string, Set<string>> = new Map();

    for (const input of serializedReport.inputs || []) {
        const dependenciesSet = new Set(input.dependencies);
        const dependentsSet = new Set(input.dependents);

        // Create the sets for all the dependencies.
        for (const dep of dependenciesSet) {
            if (!fileDependents.has(dep)) {
                fileDependents.set(dep, new Set());
            }
            fileDependents.get(dep)!.add(input.filepath);
        }

        // Create the sets for all the dependents.
        for (const dep of dependentsSet) {
            if (!fileDependencies.has(dep)) {
                fileDependencies.set(dep, new Set());
            }
            fileDependencies.get(dep)!.add(input.filepath);
        }

        if (fileDependencies.has(input.filepath)) {
            // If we already have a set for this file, we complete it.
            const existingDependencies = fileDependencies.get(input.filepath)!;
            for (const dep of existingDependencies) {
                dependenciesSet.add(dep);
            }
        }

        if (fileDependents.has(input.filepath)) {
            // If we already have a set for this file, we complete it.
            const existingDependents = fileDependents.get(input.filepath)!;
            for (const dep of existingDependents) {
                dependentsSet.add(dep);
            }
        }

        fileDependencies.set(input.filepath, dependenciesSet);
        fileDependents.set(input.filepath, dependentsSet);

        inputs.set(input.filepath, {
            name: input.name,
            size: input.size,
            dependencies: dependenciesSet,
            dependents: dependentsSet,
        });
    }

    for (const [filepath, input] of inputs) {
        const inputDependencies = fileDependencies.get(filepath) || new Set();
        const inputDependents = fileDependents.get(filepath) || new Set();

        // Aggregate size.
        let aggregatedSize = input.size;
        for (const dep of inputDependencies) {
            aggregatedSize += inputs.get(dep)?.size || 0;
        }

        dependencies.add({
            name: input.name,
            size: input.size,
            aggregatedSize,
            dependents: inputDependents,
            dependencies: inputDependencies,
        });
    }

    if (!dependencies.size) {
        return [dependentsToPrint, dependenciesToPrint, sizesToPrint];
    }

    const dependenciesArray = Array.from(dependencies);
    // Sort by dependents, biggest first
    dependenciesArray.sort(sortDesc((file: FileReport) => file.dependents.size));
    dependentsToPrint.values = dependenciesArray.map((file) => ({
        name: file.name,
        value: file.dependents.size.toString(),
    }));
    // Sort by dependencies, biggest first
    dependenciesArray.sort(sortDesc((file: FileReport) => file.dependencies.size));
    dependenciesToPrint.values = dependenciesArray.map((file) => ({
        name: file.name,
        value: file.dependencies.size.toString(),
    }));
    // Sort by size, biggest first
    dependenciesArray.sort(sortDesc('size'));
    sizesToPrint.values = dependenciesArray.map((file) => ({
        name: file.name,
        value: prettyBytes(file.size),
    }));
    // Sort by aggregated size, biggest first
    dependenciesArray.sort(sortDesc('aggregatedSize'));
    aggregatedSizesToPrint.values = dependenciesArray.map((file) => ({
        name: file.name,
        value: prettyBytes(file.aggregatedSize || file.size),
    }));

    return [dependentsToPrint, dependenciesToPrint, sizesToPrint, aggregatedSizesToPrint];
};

const getTimingValues = (name: string, timings?: TimingsMap): ValuesToPrint[] => {
    if (!timings || !timings.size) {
        return [];
    }

    const times = Array.from(timings.values());
    // Sort by duration, longest first
    times.sort(sortDesc('duration'));
    const durationsToPrint: ValuesToPrint = {
        name: `${name} duration`,
        values: times.map((module) => ({
            name: module.name,
            value: formatDuration(module.duration),
        })),
        top: true,
    };

    // Sort by increment, biggest first
    times.sort(sortDesc('increment'));
    const hitsToPrint: ValuesToPrint = {
        name: `${name} hits`,
        values: times.map((module) => ({
            name: module.name,
            value: module.increment.toString(),
        })),
        top: true,
    };

    return [durationsToPrint, hitsToPrint];
};

const renderValues = (values: ValuesToPrint[]): string => {
    let outputString = '';
    const titlePadding = 4;
    const valuePadding = 4;
    const maxTitleWidth = Math.max(...values.map((val) => val.name.length));
    const maxNameWidth = Math.max(...values.flatMap((val) => val.values.map((v) => v.name.length)));
    const maxValueWidth = Math.max(
        ...values.flatMap((val) => val.values.map((v) => v.value.length)),
    );
    const totalWidth = Math.max(
        maxTitleWidth + titlePadding,
        maxNameWidth + maxValueWidth + valuePadding,
    );

    // TODO: Compute max sizes only on the printed values (using TOP).
    for (const group of values) {
        if (group.values.length === 0) {
            continue;
        }

        const title =
            group.top && group.values.length >= TOP ? `Top ${TOP} ${group.name}` : group.name;
        const titlePad = totalWidth - (title.length + titlePadding);

        outputString += `\n== ${title} ${'='.repeat(titlePad)}=\n`;

        const valuesToPrint = group.top ? group.values.slice(0, TOP) : group.values;
        for (const value of valuesToPrint) {
            const valuePad = maxValueWidth - value.value.length;
            outputString += ` [${numColor(value.value)}] ${' '.repeat(valuePad)}${nameColor(value.name)}\n`;
        }
    }

    return outputString;
};

export const outputTexts = (globalContext: GlobalContext, log: Logger, report?: Report) => {
    const valuesToPrint: ValuesToPrint[] = [];

    if (report) {
        // Output legacy/tracing.
        valuesToPrint.push(...getTimingValues('Loader', report.timings.loaders));
        valuesToPrint.push(...getTimingValues('Tapable', report.timings.tapables));
        valuesToPrint.push(...getTimingValues('Module', report.timings.modules));
    }

    valuesToPrint.push(...getModulesValues(globalContext));
    valuesToPrint.push(...getAssetsValues(globalContext));
    valuesToPrint.push(...getGeneralValues(globalContext));

    const outputString = renderValues(valuesToPrint);

    log(outputString, 'info');
};
