// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import { forwardLines, isYarnPnpRuntime, resolveViteModuleRunner } from './local-execution-process';

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

    describe("Yarn Plug'n'Play", () => {
        const previous = process.versions.pnp;

        afterEach(() => {
            if (previous === undefined) {
                delete process.versions.pnp;
            } else {
                process.versions.pnp = previous;
            }
        });

        test.each([
            { pnp: '3', expected: true },
            { pnp: undefined, expected: false },
        ])('Should report $expected when process.versions.pnp is $pnp', ({ pnp, expected }) => {
            if (pnp === undefined) {
                delete process.versions.pnp;
            } else {
                process.versions.pnp = pnp;
            }
            expect(isYarnPnpRuntime()).toBe(expected);
        });
    });

    describe('Vite module runner', () => {
        let projectsDir = '';

        beforeAll(() => {
            projectsDir = fs.realpathSync.native(
                fs.mkdtempSync(path.join(os.tmpdir(), 'dd-apps-vite-runner-')),
            );
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
                        './module-runner': { import: './dist/node/module-runner.js' },
                        './package.json': './package.json',
                    },
                }),
            );
            return { projectRoot, runner: path.join(viteDir, 'dist', 'node', 'module-runner.js') };
        };

        test.each(['6.0.4', '6.4.3', '7.0.0-beta.1', '8.3.3'])(
            'Should use the module runner of Vite %s',
            (version) => {
                const { projectRoot, runner } = projectWithVite(version);
                expect(resolveViteModuleRunner(projectRoot)).toBe(runner);
            },
        );

        // Their dev server answers the runner in an older shape, { r } and { e }.
        test.each(['6.0.0', '6.0.3', '6.0.4-beta.0'])(
            'Should not use the module runner of Vite %s',
            (version) => {
                const { projectRoot } = projectWithVite(version);
                expect(resolveViteModuleRunner(projectRoot)).toBeUndefined();
            },
        );
    });
});
