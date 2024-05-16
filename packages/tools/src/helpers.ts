import chalk from 'chalk';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const green = chalk.bold.green;
export const red = chalk.bold.red;
export const bold = chalk.bold;

export const NAME = 'build-plugins';

if (!process.env.PROJECT_CWD) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}
export const ROOT = process.env.PROJECT_CWD!;

export const IMPORTS_KEY = '/* #imports-injection-placeholder */';
export const TYPES_KEY = '/* #types-injection-placeholder */';
export const CONFIGS_KEY = '/* #configs-injection-placeholder */';

const execFileP = promisify(execFile);
const maxBuffer = 1024 * 1024;

export const execute = (cmd: string, args: string[], cwd: string) =>
    execFileP(cmd, args, { maxBuffer, cwd, encoding: 'utf-8' });

export const injectIntoString = (content: string, mark: string, injection: string) => {
    const index = content.indexOf(mark) + mark.length;
    return content.slice(0, index) + injection + content.slice(index);
};
