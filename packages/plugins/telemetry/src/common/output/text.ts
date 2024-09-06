// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration } from '@dd/core/helpers';
import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';
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
    size: number;
    dependencies: string[];
    dependents: string[];
};

// Sort a collection by attribute
const sortDesc = (attr: any) => (a: any, b: any) => {
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

// Crawl through collection to gather all dependencies or dependents.
const getAll = (
    attribute: 'dependents' | 'dependencies',
    collection: Record<string, FileReport>,
    filepath: string,
    accumulator: string[] = [],
): string[] => {
    const reported: string[] = collection[filepath]?.[attribute] || [];
    for (const reportedFilename of reported) {
        if (accumulator.includes(reportedFilename) || reportedFilename === filepath) {
            continue;
        }

        accumulator.push(reportedFilename);
        getAll(attribute, collection, reportedFilename, accumulator);
    }
    return accumulator;
};

const getModulesValues = (context: GlobalContext): ValuesToPrint[] => {
    const dependentsToPrint: ValuesToPrint = {
        name: `Module dependents`,
        values: [],
        top: true,
    };
    const dependenciesToPrint: ValuesToPrint = {
        name: `Module dependencies`,
        values: [],
        top: true,
    };
    const sizesToPrint: ValuesToPrint = {
        name: `Raw aggregated size`,
        values: [],
        top: true,
    };

    const dependencies: FileReport[] = [];

    // Build our collections.
    const inputs = Object.fromEntries(
        (context.build?.inputs || []).map((input) => [
            input.filepath,
            {
                name: input.name,
                size: input.size,
                dependencies: input.dependencies.map((dep) => dep.filepath),
                dependents: input.dependents.map((dep) => dep.filepath),
            },
        ]),
    );

    for (const filepath in inputs) {
        if (!Object.hasOwn(inputs, filepath)) {
            continue;
        }
        const fileDependencies = getAll('dependencies', inputs, filepath);
        // Aggregate size.
        const size = fileDependencies.reduce(
            (acc, dep) => acc + inputs[dep].size,
            inputs[filepath].size,
        );

        dependencies.push({
            name: inputs[filepath].name,
            size,
            dependents: getAll('dependents', inputs, filepath),
            dependencies: fileDependencies,
        });
    }

    if (!dependencies.length) {
        return [dependentsToPrint, dependenciesToPrint, sizesToPrint];
    }

    // Sort by dependents, biggest first
    dependencies.sort(sortDesc((file: FileReport) => file.dependents.length));
    dependentsToPrint.values = dependencies.map((file) => ({
        name: file.name,
        value: file.dependents.length.toString(),
    }));
    // Sort by dependencies, biggest first
    dependencies.sort(sortDesc((file: FileReport) => file.dependencies.length));
    dependenciesToPrint.values = dependencies.map((file) => ({
        name: file.name,
        value: file.dependencies.length.toString(),
    }));
    // Sort by size, biggest first
    dependencies.sort(sortDesc('size'));
    sizesToPrint.values = dependencies.map((file) => ({
        name: file.name,
        value: prettyBytes(file.size),
    }));

    return [dependentsToPrint, dependenciesToPrint, sizesToPrint];
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
    valuesToPrint.push(...getGeneralValues(globalContext));

    const outputString = renderValues(valuesToPrint);

    log(outputString, 'info');
};
