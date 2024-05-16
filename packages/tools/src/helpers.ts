// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import chalk from 'chalk';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const green = chalk.bold.green;
export const red = chalk.bold.red;
export const blue = chalk.bold.cyan;
export const bold = chalk.bold;

export const NAME = 'build-plugins';

if (!process.env.PROJECT_CWD) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}
export const ROOT = process.env.PROJECT_CWD!;

export const IMPORTS_KEY = '#imports-injection-placeholder';
export const TYPES_KEY = '#types-injection-placeholder';
export const CONFIGS_KEY = '#configs-injection-placeholder';

const execFileP = promisify(execFile);
const maxBuffer = 1024 * 1024;

export const execute = (cmd: string, args: string[], cwd: string) =>
    execFileP(cmd, args, { maxBuffer, cwd, encoding: 'utf-8' });

export const injectIntoString = (content: string, mark: string, injection: string) => {
    // Find the mark
    const contentArray = content.split('\n');
    const index = contentArray.findIndex((line) => line.includes(mark));

    // Inject the new content
    if (index === -1) {
        throw new Error(`Could not find the mark ${green(mark)} in the content.`);
    }
    contentArray.splice(index, 0, injection);

    return contentArray.join('\n');
};
