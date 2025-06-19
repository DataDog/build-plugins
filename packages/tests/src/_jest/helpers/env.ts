// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { FULL_NAME_BUNDLERS } from '@dd/core/constants';
import { mkdirSync } from '@dd/core/helpers/fs';
import type { BundlerFullName } from '@dd/core/types';
import { bgYellow, dim, green, red } from '@dd/tools/helpers';
import fs from 'fs';
import os from 'os';
import path from 'path';

const fsp = fs.promises;

type TestEnv = {
    NO_CLEANUP: boolean;
    NEED_BUILD: boolean;
    REQUESTED_BUNDLERS: string[];
    JEST_SILENT: boolean;
};

export const getEnv = (argv: string[]): TestEnv => {
    // Handle --cleanup flag.
    const NO_CLEANUP = argv.includes('--cleanup=0');

    // Handle --build flag.
    const NEED_BUILD = argv.includes('--build=1');

    // Handle --bundlers flag.
    const REQUESTED_BUNDLERS = argv.includes('--bundlers')
        ? argv[argv.indexOf('--bundlers') + 1].split(',')
        : argv
              .find((arg) => arg.startsWith('--bundlers='))
              ?.split('=')[1]
              .split(',') ?? [];

    // Handle --silent flag.
    const JEST_SILENT = argv.includes('--silent');

    return {
        NO_CLEANUP,
        NEED_BUILD,
        REQUESTED_BUNDLERS,
        JEST_SILENT,
    };
};

export const setupEnv = (env: TestEnv): void => {
    const { NO_CLEANUP, NEED_BUILD, REQUESTED_BUNDLERS, JEST_SILENT } = env;

    if (NO_CLEANUP) {
        process.env.NO_CLEANUP = '1';
    }

    if (NEED_BUILD) {
        process.env.NEED_BUILD = '1';
    }

    if (REQUESTED_BUNDLERS.length) {
        process.env.REQUESTED_BUNDLERS = REQUESTED_BUNDLERS.join(',');
    }

    if (JEST_SILENT) {
        process.env.JEST_SILENT = '1';
    }
};

export const logEnv = (env: TestEnv) => {
    const { NO_CLEANUP, NEED_BUILD, REQUESTED_BUNDLERS, JEST_SILENT } = env;
    const envLogs = [];
    if (NO_CLEANUP) {
        envLogs.push(bgYellow(" Won't clean up "));
    }

    if (JEST_SILENT) {
        envLogs.push(bgYellow(' Silent Mode '));
    }

    if (NEED_BUILD) {
        envLogs.push(bgYellow(' Will also build used plugins '));
    }

    if (REQUESTED_BUNDLERS.length) {
        if (
            !(REQUESTED_BUNDLERS as BundlerFullName[]).every((bundler) =>
                FULL_NAME_BUNDLERS.includes(bundler),
            )
        ) {
            throw new Error(
                `Invalid "${red(`--bundlers ${REQUESTED_BUNDLERS.join(',')}`)}".\nValid bundlers are ${FULL_NAME_BUNDLERS.map(
                    (b) => green(b),
                ).join(', ')}.`,
            );
        }
        const bundlersList = REQUESTED_BUNDLERS.map((bundler) => green(bundler)).join(', ');
        envLogs.push(`Running ${bgYellow(' ONLY ')} for ${bundlersList}.`);
    }

    if (!NO_CLEANUP || !NEED_BUILD || REQUESTED_BUNDLERS.length) {
        const tips: string[] = [];
        if (!NO_CLEANUP) {
            tips.push(`  ${green('--cleanup=0')} to keep the built artifacts.`);
        }
        if (!NEED_BUILD) {
            tips.push(`  ${green('--build=1')} to force the build of the used plugins.`);
        }
        if (!REQUESTED_BUNDLERS.length) {
            tips.push(`  ${green('--bundlers=webpack4,esbuild')} to only use specified bundlers.`);
        }
        envLogs.push(dim(`\nYou can also use : \n${tips.join('\n')}\n`));
    }

    if (envLogs.length) {
        console.log(`\n${envLogs.join('\n')}\n`);
    }
};

export const getOutDir = (workingDir: string, folderName: string): string => {
    return path.resolve(workingDir, `./dist/${folderName}`);
};

export const getTempWorkingDir = (seed: string) => {
    const tmpDir = os.tmpdir();
    const workingDir = path.resolve(tmpDir, seed);

    // Create the directory.
    mkdirSync(workingDir);

    // Need to use realpathSync to avoid issues with symlinks on macos (prefix with /private).
    // cf: https://github.com/nodejs/node/issues/11422
    return fs.realpathSync(workingDir);
};

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');
export const prepareWorkingDir = async (seed: string) => {
    const timeId = `[${dim.cyan('Preparing working directory duration')}]`;
    console.time(timeId);
    const workingDir = getTempWorkingDir(seed);

    // Copy mock projects into it.
    await fsp.cp(`${FIXTURE_DIR}/`, `${workingDir}/`, {
        recursive: true,
        errorOnExist: true,
        force: true,
    });

    console.timeEnd(timeId);

    return workingDir;
};
