// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ALL_BUNDLERS, SUPPORTED_BUNDLERS } from '@dd/core/constants';
import { readJsonSync } from '@dd/core/helpers/fs';
import type {
    BundlerFullName,
    BundlerName,
    GetPluginsArg,
    GetPlugins,
    OptionsWithDefaults,
} from '@dd/core/types';
import { getContext } from '@dd/factory/helpers/context';
import chalk from 'chalk';
import { execFile, execFileSync } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { ROOT } from './constants';
import type { SlugLessWorkspace, Workspace } from './types';

export const green = chalk.bold.green;
export const yellow = chalk.bold.yellow;
export const grey = chalk.bold.grey;
export const red = chalk.bold.red;
export const bgYellow = chalk.bold.bgYellow.black;
export const bgGreen = chalk.bold.bgGreen.black;
export const blue = chalk.bold.cyan;
export const bold = chalk.bold;
export const dim = chalk.dim;
export const dimRed = chalk.red;

const execFileP = promisify(execFile);
const maxBuffer = 1024 * 1024;

export const execute = (cmd: string, args: string[], cwd: string = ROOT) =>
    execFileP(cmd, args, { maxBuffer, cwd, encoding: 'utf-8' });

export const executeSync = (cmd: string, args: string[], cwd: string = ROOT) =>
    execFileSync(cmd, args, { maxBuffer, cwd, encoding: 'utf-8' });

export const slugify = (string: string) => {
    return string
        .toString()
        .normalize('NFD') // Split an accented letter in the base letter and the acent
        .replace(/[\u0300-\u036f]/g, '') // Remove all previously split accents
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9 -]/g, '') // Remove all chars not letters, numbers and spaces
        .replace(/\s+/g, '-'); // Collapse whitespace and replace by -
};

export const escapeStringForRegExp = (str: string) =>
    str
        // Escape sensible chars in RegExps.
        .replace(/([().[\]])/g, '\\$1')
        // Replace quotes to allow for both single and double quotes.
        .replace(/["']/g, `(?:"|')`);

// Inject some text in between two markers.
export const replaceInBetween = (content: string, mark: string, injection: string) => {
    const escapedMark = mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedInjection = injection.replace(/\$/g, '$$$$');
    const rx = new RegExp(
        `${escapedMark}([\\S\\s](?!${escapedMark}))*(\\s|\\S)?${escapedMark}`,
        'gm',
    );
    return content.replace(rx, `${mark}\n${escapedInjection}\n${mark}`);
};

export const getTitle = (name: string): string =>
    name
        .toLowerCase()
        .split(/-+/g)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');

export const getPascalCase = (name: string): string => getTitle(name).replace(/ /g, '');

export const getCamelCase = (name: string): string => {
    const pascal = getPascalCase(name);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

export const getPackageJsonData = (workspace: string = 'plugins/telemetry'): any => {
    const packageJson = readJsonSync(path.resolve(ROOT, `packages/${workspace}/package.json`));
    return packageJson;
};

type Autofix = {
    name: string;
    cmd: string;
    args: string[];
};
const AUTOFIXES: Autofix[] = [
    // Run yarn to update lockfiles.
    {
        name: 'Install dependencies',
        cmd: 'yarn',
        args: [],
    },
    // Run yarn format to ensure all files are well formated.
    {
        name: 'Format codebase',
        cmd: 'yarn',
        args: ['format'],
    },
    // Run yarn typecheck:all to typecheck the codebase.
    {
        name: 'Typechecking',
        cmd: 'yarn',
        args: ['typecheck:all'],
    },
    // Run yarn oss to update headers and licenses if necessary.
    {
        name: 'Open Source Compliance',
        cmd: 'yarn',
        args: ['oss'],
    },
];

export const runAutoFixes = async () => {
    const errors: string[] = [];

    const addError = (autofix: Autofix, message: string) => {
        const messageToDisplay = dimRed(
            message
                .trim()
                .split('\n')
                .map((st) => `    ${st}`)
                .join(`\n`),
        );
        const prefix = `[${red('Error')}] `;
        const actionId = `${red(autofix.name)} (${dim(autofix.cmd)} ${dim(autofix.args.join(' '))})`;
        errors.push(`${prefix}Failed to run "${actionId}":\n${messageToDisplay}\n`);
    };

    for (const autofix of AUTOFIXES) {
        console.log(`  Running ${green(autofix.name)}.`);
        try {
            await execute(autofix.cmd, autofix.args);
        } catch (e: any) {
            addError(autofix, e.stdout);
        }
    }

    return errors;
};

export const buildPlugins = (bundlerNames: (BundlerName | BundlerFullName)[]) => {
    const bundlersToBuild = Array.from(
        new Set(bundlerNames.map((name) => name.replace(/\d/g, ''))),
    );

    return executeSync('yarn', [
        'workspaces',
        'foreach',
        '-Apti',
        ...bundlersToBuild.map((bundler) => ['--include', `@datadog/${bundler}-plugin`]).flat(),
        'run',
        'build',
    ]);
};

export const getWorkspaces = async (
    filter?: (workspace: SlugLessWorkspace) => boolean,
): Promise<Workspace[]> => {
    const { stdout: rawWorkspaces } = await execute('yarn', ['workspaces', 'list', '--json']);
    // Replace new lines with commas to make it JSON valid.
    const jsonString = `[${rawWorkspaces.replace(/\n([^\]])/g, ',\n$1')}]`;
    const workspacesArray = JSON.parse(jsonString) as SlugLessWorkspace[];
    return workspacesArray
        .filter((workspace: SlugLessWorkspace) => (filter ? filter(workspace) : true))
        .map((workspace: SlugLessWorkspace) => {
            const plugin: Workspace = {
                ...workspace,
                slug: workspace.location.split('/').pop() as string,
            };
            return plugin;
        });
};

// TODO: Update this, it's a bit hacky.
export const getSupportedBundlers = (getPlugins: GetPlugins) => {
    const arg: GetPluginsArg = {
        options: {
            telemetry: {},
            errorTracking: {
                sourcemaps: {
                    releaseVersion: '0',
                    service: 'service',
                    minifiedPathPrefix: '/minifiedUrl',
                },
            },
        },
        context: getContext({
            // We don't care, this is a hack.
            start: 0,
            options: {} as OptionsWithDefaults,
            data: {
                bundler: {
                    name: 'esbuild',
                    fullName: 'esbuild',
                    variant: '',
                    version: '1.0.0',
                },
                metadata: {},
                env: 'test',
                packageName: '@datadog/esbuild-plugin',
                version: '0',
            },
            stores: {
                errors: [],
                warnings: [],
                logs: [],
                timings: [],
                queue: [],
            },
        }),
        bundler: {},
    };

    const plugins = getPlugins(arg);

    const bundlerSpecifics = [];
    const universals = [];

    for (const plugin of plugins) {
        const hooks = Object.keys(plugin).filter((key) => !key.match(/^(name|enforce)$/));
        bundlerSpecifics.push(...hooks.filter((hook) => ALL_BUNDLERS.includes(hook)));
        universals.push(...hooks.filter((hook) => !ALL_BUNDLERS.includes(hook)));
    }

    // If the plugin has bundler specific hooks, it means it only supports these.
    const supportedBundlers = bundlerSpecifics.length
        ? Array.from(new Set(bundlerSpecifics))
        : [...SUPPORTED_BUNDLERS];

    return supportedBundlers.sort();
};

export const getBundlerPicture = (bundler: string) => {
    const bundlers: Record<string, { name: string; imgPath: string }> = {
        esbuild: {
            name: 'ESBuild',
            imgPath: 'packages/assets/src/esbuild.svg',
        },
        rollup: {
            name: 'Rollup',
            imgPath: 'packages/assets/src/rollup.svg',
        },
        rspack: {
            name: 'Rspack',
            imgPath: 'packages/assets/src/rspack.svg',
        },
        vite: {
            name: 'Vite',
            imgPath: 'packages/assets/src/vite.svg',
        },
        webpack: {
            name: 'Webpack',
            imgPath: 'packages/assets/src/webpack.svg',
        },
    };

    const bundlerInfos = bundlers[bundler];
    if (!bundlerInfos) {
        return '';
    }

    const { imgPath, name } = bundlerInfos;

    return `<img src="${imgPath}" alt="${name}" width="17" />`;
};

export const isInternalPluginWorkspace = (workspace: Workspace) =>
    workspace.name.startsWith('@dd/internal-');
