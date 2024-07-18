// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import chalk from 'chalk';
import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';

import { ALL_BUNDLERS, ROOT, SUPPORTED_BUNDLERS } from './constants';
import type { SlugLessWorkspace } from './types';

export const green = chalk.bold.green;
export const red = chalk.bold.red;
export const blue = chalk.bold.cyan;
export const bold = chalk.bold;
export const dim = chalk.dim;

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
        .replace(/[^a-z0-9 -]/g, '') // Remove all chars not letters, numbers and spaces
        .replace(/\s+/g, '-'); // Collapse whitespace and replace by -
};

// Inject some text in between two markers.
export const replaceInBetween = (content: string, mark: string, injection: string) => {
    const rx = new RegExp(`${mark}[\\S\\s]*${mark}`, 'gm');
    return content.replace(rx, `${mark}\n${injection}\n${mark}`);
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

export const getPackageJsonData = (workspace: string = 'plugins/telemetry'): any => {
    const packageJson = fs.readJSONSync(path.resolve(ROOT, `packages/${workspace}/package.json`));
    return packageJson;
};

export const runAutoFixes = async () => {
    // Run yarn to update lockfiles.
    console.log(`  Running ${green('yarn')}.`);
    await execute('yarn', []);

    // Run yarn format to ensure all files are well formated.
    console.log(`  Running ${green('yarn format')}.`);
    await execute('yarn', ['format']);

    // Run yarn oss to update headers and licenses if necessary.
    console.log(`  Running ${green('yarn oss')}.`);
    await execute('yarn', ['oss']);
};

export const getWorkspaces = async (filter?: (workspace: SlugLessWorkspace) => boolean) => {
    const { stdout: rawWorkspaces } = await execute('yarn', ['workspaces', 'list', '--json']);
    // Replace new lines with commas to make it JSON valid.
    const jsonString = `[${rawWorkspaces.replace(/\n([^\]])/g, ',\n$1')}]`;
    const workspacesArray = JSON.parse(jsonString) as SlugLessWorkspace[];
    return workspacesArray
        .filter((workspace: SlugLessWorkspace) => (filter ? filter(workspace) : true))
        .map((workspace: SlugLessWorkspace) => ({
            ...workspace,
            slug: workspace.location.split('/').pop() as string,
        }));
};

export const getSupportedBundlers = (getPlugins: any) => {
    const plugins = getPlugins(
        {
            telemetry: {},
            rum: {
                sourcemaps: {
                    releaseVersion: '0',
                    service: 'service',
                    minifiedPathPrefix: '/minifiedUrl',
                },
            },
        },
        { cwd: ROOT, version: '0', outputDir: ROOT, bundler: { name: 'random' } },
    );

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
        webpack: {
            name: 'Webpack',
            imgPath: 'packages/assets/src/webpack.svg',
        },
        vite: {
            name: 'Vite',
            imgPath: 'packages/assets/src/vite.svg',
        },
    };

    const bundlerInfos = bundlers[bundler];
    if (!bundlerInfos) {
        return '';
    }

    const { imgPath, name } = bundlerInfos;

    return `<img src="${imgPath}" alt="${name}" width="17" />`;
};
