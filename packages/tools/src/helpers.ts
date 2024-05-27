// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import chalk from 'chalk';
import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';

import { ROOT } from './constants';

export const green = chalk.bold.green;
export const red = chalk.bold.red;
export const blue = chalk.bold.cyan;
export const bold = chalk.bold;

const execFileP = promisify(execFile);
const maxBuffer = 1024 * 1024;

export const execute = (cmd: string, args: string[], cwd: string = ROOT) =>
    execFileP(cmd, args, { maxBuffer, cwd, encoding: 'utf-8' });

export const slugify = (string: string) => {
    return string
        .toString()
        .normalize('NFD') // Split an accented letter in the base letter and the acent
        .replace(/[\u0300-\u036f]/g, '') // Remove all previously split accents
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9 ]/g, '') // Remove all chars not letters, numbers and spaces
        .replace(/\s+/g, '-'); // Collapse whitespace and replace by -
};

// Inject some text in between two markers.
export const replaceInBetween = (content: string, mark: string, injection: string) => {
    const rx = new RegExp(`${mark}[\\S\\s]*${mark}`, 'gm');
    return content.replace(rx, `${mark}\n\n${injection}\n\n${mark}`);
};

export const injectIntoString = (content: string, mark: string, injection: string) => {
    // Find the mark
    const contentArray = content.split('\n');
    const index = contentArray.findIndex((line) => line.includes(mark));

    if (index === -1) {
        throw new Error(`Could not find the mark ${green(mark)} in the content.`);
    }
    // Inject the new content
    contentArray.splice(index, 0, injection);

    return contentArray.join('\n');
};

export const getTitle = (name: string): string =>
    name
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');

export const getUpperCase = (name: string): string =>
    getTitle(name).toUpperCase().replace(/ /g, '_');

export const getPascalCase = (name: string): string => getTitle(name).replace(/ /g, '');

export const getCamelCase = (name: string): string => {
    const pascal = getPascalCase(name);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

export const getPackageJsonData = (): any => {
    const packageJson = fs.readJSONSync(
        path.resolve(ROOT, 'packages/plugins/telemetry/package.json'),
    );
    return packageJson;
};
