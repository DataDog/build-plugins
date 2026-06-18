#!/usr/bin/env node
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, getOriginHeaders } from '@dd/core/helpers/request';
import type { Logger } from '@dd/core/types';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { Readable } from 'stream';

import { resolveIdentifier } from './identifier';
import { getReleaseUrl } from './upload';
import { readVersionCache } from './version-cache';

const green = chalk.green.bold;
const red = chalk.red.bold;
const yellow = chalk.yellow.bold;
const cyan = chalk.cyan.bold;

// CLI-safe output: process.stdout/stderr avoid the no-console lint rule,
// which is appropriate for library code but not for a CLI entry point.
const print = (msg: string) => process.stdout.write(`${msg}\n`);
const printErr = (msg: string) => process.stderr.write(`${msg}\n`);

const makeCliLogger = (): Logger => {
    const logger: Logger = {
        error: (msg: unknown) => printErr(red(String(msg))),
        warn: (msg: unknown) => printErr(yellow(String(msg))),
        info: (msg: unknown) => print(String(msg)),
        debug: (_msg: unknown) => {},
        getLogger: () => logger,
        time: () => {
            throw new Error('time() is not supported in CLI logger');
        },
    };
    return logger;
};

const cliLogger = makeCliLogger();

const USAGE = `Usage: datadog-apps <command> [options]

Commands:
  deploy [--no-publish]      Build and upload the app. Publishes by default.
  publish [--version <id>]   Publish an uploaded version without rebuilding.
`;

const runDeploy = (args: string[]) => {
    let noPublish = false;
    const viteArgs: string[] = [];

    for (const arg of args) {
        if (arg === '--no-publish') {
            noPublish = true;
        } else {
            viteArgs.push(arg);
        }
    }

    const env: Record<string, string | undefined> = {
        ...process.env,
        DATADOG_APPS_UPLOAD_ASSETS: 'true',
    };

    if (noPublish) {
        env.DD_APPS_PUBLISH = 'false';
    }

    const viteCmd = ['vite', 'build', ...viteArgs].join(' ');
    print(cyan(`Running: ${viteCmd}`));

    const result = spawnSync(viteCmd, {
        shell: true,
        stdio: 'inherit',
        env,
    });

    if (result.error) {
        printErr(red(`Failed to spawn vite build: ${result.error.message}`));
        process.exit(1);
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
};

const runPublish = async (args: string[]) => {
    let versionId: string | undefined;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--version' && i + 1 < args.length) {
            versionId = args[i + 1];
            i++;
        }
    }

    const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY;
    const appKey = process.env.DATADOG_APP_KEY || process.env.DD_APP_KEY;
    const site = process.env.DATADOG_SITE || process.env.DD_SITE || 'datadoghq.com';

    if (!apiKey || !appKey) {
        printErr(red('Missing authentication credentials. Set DD_API_KEY and DD_APP_KEY.'));
        process.exit(1);
    }

    let identifier: string | undefined;

    if (!versionId) {
        const cache = readVersionCache();
        if (!cache) {
            printErr(
                red(
                    `No --version provided and no version cache found (.datadog-app-version.json).\n` +
                        `Run \`datadog-apps deploy\` first, or pass --version <id>.`,
                ),
            );
            process.exit(1);
        }
        versionId = cache.version_id;
        identifier = cache.identifier;
        print(`Using cached version ${cyan(versionId)} for identifier ${cyan(identifier)}`);
    }

    if (!identifier) {
        identifier =
            process.env.DD_APPS_IDENTIFIER ||
            process.env.DATADOG_APPS_IDENTIFIER ||
            resolveIdentifier(process.cwd(), cliLogger).identifier;
    }

    if (!identifier) {
        printErr(
            red(
                'Could not determine app identifier. Set DD_APPS_IDENTIFIER or run from your app directory.',
            ),
        );
        process.exit(1);
    }

    const releaseUrl = getReleaseUrl(site, identifier);
    const defaultHeaders = getOriginHeaders({
        bundler: 'vite',
        plugin: 'apps',
        version: '0.0.0',
    });

    print(`Publishing version ${cyan(versionId)} to ${green(releaseUrl)}...`);

    try {
        await doRequest({
            auth: { apiKey, appKey },
            url: releaseUrl,
            method: 'PUT',
            type: 'json',
            getData: async () => ({
                data: Readable.from(JSON.stringify({ version_id: versionId })),
                headers: {
                    'Content-Type': 'application/json',
                    ...defaultHeaders,
                },
            }),
        });
        print(green(`Successfully published version ${versionId} to live.`));
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        printErr(red(`Failed to publish: ${msg}`));
        process.exit(1);
    }
};

const main = async () => {
    const [, , command, ...rest] = process.argv;

    if (!command || command === '--help' || command === '-h') {
        print(USAGE);
        process.exit(0);
    }

    if (command === 'deploy') {
        runDeploy(rest);
    } else if (command === 'publish') {
        await runPublish(rest);
    } else {
        printErr(red(`Unknown command: ${command}`));
        print(USAGE);
        process.exit(1);
    }
};

main().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    printErr(red(`Unexpected error: ${msg}`));
    process.exit(1);
});
