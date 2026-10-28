// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import type { BackendFunction } from '../backend/types';

import {
    createChildProcessExecutor,
    forwardLines,
    MODULE_RUNNER_UNRESOLVED_MESSAGE,
    resolveViteModuleRunner,
    YARN_PNP_UNSUPPORTED_MESSAGE,
} from './local-execution-process';
import { DEFAULT_LONG_POLLING_CONFIG } from './local-execution';

describe('Local execution process helpers', () => {
    describe('Line forwarding', () => {
        test('Should split lines across chunks and flush the last one at the end', () => {
            const stream = new PassThrough();
            const lines: string[] = [];
            forwardLines(stream, (line) => lines.push(line));
            for (const chunk of ['a', 'b\nc', '\r\n', 'd\ne', 'f']) {
                stream.write(chunk);
            }
            stream.end();
            return new Promise<void>((resolve) => {
                stream.on('end', () => {
                    expect(lines).toEqual(['ab', 'c', 'd', 'ef']);
                    resolve();
                });
                stream.resume();
            });
        });
    });

    describe('Unavailable local execution', () => {
        const previousPnp = process.versions.pnp;
        const func: BackendFunction = {
            relativePath: 'src/example',
            name: 'example',
            absolutePath: '/project/src/example.backend.ts',
            allowedConnectionIds: [],
        };

        afterEach(() => {
            if (previousPnp === undefined) {
                delete process.versions.pnp;
            } else {
                process.versions.pnp = previousPnp;
            }
        });

        test.each([
            {
                setup: "a Yarn Plug'n'Play dev server",
                pnp: '3',
                moduleRunnerPath: '/vite/module-runner.js',
                message: YARN_PNP_UNSUPPORTED_MESSAGE,
            },
            {
                setup: 'no resolvable vite/module-runner',
                pnp: undefined,
                moduleRunnerPath: undefined,
                message: MODULE_RUNNER_UNRESOLVED_MESSAGE,
            },
        ])(
            'Should warn once and fail every call, before running it, on $setup',
            async ({ pnp, moduleRunnerPath, message }) => {
                if (pnp === undefined) {
                    delete process.versions.pnp;
                } else {
                    process.versions.pnp = pnp;
                }
                const log = getMockLogger({ warn: jest.fn() });
                const getRuntimeContext = jest.fn(async () => ({}));
                const executor = createChildProcessExecutor({
                    invokeChannel: { handleInvoke: async () => ({}) },
                    projectRoot: '/project',
                    childEntryPath: '/unused/local-execution-child.mjs',
                    moduleRunnerPath,
                    log,
                });
                const call = () =>
                    executor({
                        func,
                        args: [],
                        executeAction: async () => ({}),
                        getRuntimeContext,
                        getAllowedConnectionIds: async () => [],
                        timeoutMs: 1000,
                        longPolling: DEFAULT_LONG_POLLING_CONFIG,
                    });

                await expect(call()).rejects.toThrow(message);
                await expect(call()).rejects.toThrow(message);
                expect(log.warn).toHaveBeenCalledTimes(1);
                expect(log.warn).toHaveBeenCalledWith(message);
                expect(getRuntimeContext).not.toHaveBeenCalled();
            },
        );
    });

    describe('Vite module runner', () => {
        let projectsDir = '';

        beforeAll(() => {
            const tmpPrefix = path.join(os.tmpdir(), 'dd-apps-vite-runner-');
            const createdDir = fs.mkdtempSync(tmpPrefix);
            projectsDir = fs.realpathSync.native(createdDir);
        });

        afterAll(() => {
            fs.rmSync(projectsDir, { recursive: true, force: true });
        });

        const projectWithVite = (version: string) => {
            const projectRoot = path.join(projectsDir, version);
            const viteDir = path.join(projectRoot, 'node_modules', 'vite');
            fs.mkdirSync(viteDir, { recursive: true });
            fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');
            fs.writeFileSync(
                path.join(viteDir, 'package.json'),
                JSON.stringify({
                    name: 'vite',
                    version,
                    exports: {
                        './module-runner': './dist/node/module-runner.js',
                        './package.json': './package.json',
                    },
                }),
            );
            return { projectRoot, runner: path.join(viteDir, 'dist', 'node', 'module-runner.js') };
        };

        test.each(['7.0.0', '7.3.7', '8.0.0-beta.1', '8.3.3'])(
            'Should use the module runner of Vite %s',
            (version) => {
                const { projectRoot, runner } = projectWithVite(version);
                expect(resolveViteModuleRunner(projectRoot)).toBe(runner);
            },
        );

        test('Should resolve nothing when Vite exports no module runner', () => {
            const { projectRoot } = projectWithVite('7.3.7-no-runner');
            const vitePackageJson = path.join(projectRoot, 'node_modules', 'vite', 'package.json');
            fs.writeFileSync(vitePackageJson, JSON.stringify({ name: 'vite', exports: {} }));
            expect(resolveViteModuleRunner(projectRoot)).toBeUndefined();
        });
    });
});
