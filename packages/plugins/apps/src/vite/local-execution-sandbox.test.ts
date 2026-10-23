// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { FIXTURE_ROOT } from './local-execution-process.fixtures';
import {
    collectReadPaths,
    createDenyFilter,
    fileOfModuleId,
    guardModuleLoadError,
    OUTSIDE_READ_ROOTS_REASON,
    permissionModelArgv,
    unreadableModuleError,
} from './local-execution-sandbox';

describe('Local execution sandbox', () => {
    describe('Readable folders', () => {
        test("Should include where a project's linked packages point", () => {
            const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-apps-links-')));
            try {
                const project = path.join(base, 'project');
                const linkedPackage = path.join(base, 'linked-package');
                const scopedPackage = path.join(base, 'scoped-package');
                fs.mkdirSync(path.join(project, 'node_modules', '@scope'), { recursive: true });
                fs.mkdirSync(linkedPackage);
                fs.mkdirSync(scopedPackage);
                fs.symlinkSync(linkedPackage, path.join(project, 'node_modules', 'linked'));
                fs.symlinkSync(scopedPackage, path.join(project, 'node_modules', '@scope', 'pkg'));

                const readPaths = collectReadPaths(
                    project,
                    '/plugin/dist/child.mjs',
                    '/vite/dist/node/module-runner.js',
                );

                expect(readPaths).toEqual(
                    expect.arrayContaining([project, linkedPackage, scopedPackage]),
                );
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        });

        test("Should include the node_modules a linked package's own dependencies are hoisted to, through link cycles", () => {
            const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-apps-links-')));
            try {
                const project = path.join(base, 'app');
                const otherWorkspace = path.join(base, 'other');
                const linkedPackage = path.join(otherWorkspace, 'packages', 'lib');
                const hoistedNodeModules = path.join(otherWorkspace, 'node_modules');
                fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
                fs.mkdirSync(path.join(hoistedNodeModules, 'dep'), { recursive: true });
                fs.mkdirSync(linkedPackage, { recursive: true });
                fs.symlinkSync(linkedPackage, path.join(project, 'node_modules', 'lib'));
                // The other workspace links back to the app, so the walk must stop on a cycle.
                fs.symlinkSync(project, path.join(hoistedNodeModules, 'app'));

                const readPaths = collectReadPaths(
                    project,
                    '/plugin/dist/child.mjs',
                    '/vite/dist/node/module-runner.js',
                );

                expect(readPaths).toEqual(
                    expect.arrayContaining([project, linkedPackage, hoistedNodeModules]),
                );
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        });
    });

    describe('Read path list', () => {
        test('Should list no folder another listed folder already covers', () => {
            const isInside = (root: string, candidate: string) => {
                const relativePath = path.relative(root, candidate);
                return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
            };
            const readPaths = collectReadPaths(
                FIXTURE_ROOT,
                '/plugin/dist/child.mjs',
                '/vite/dist/node/m.js',
                [path.dirname(FIXTURE_ROOT)],
            );
            const nested = readPaths.filter((candidate) =>
                readPaths.some((root) => root !== candidate && isInside(root, candidate)),
            );
            expect(nested).toEqual([]);
            expect(readPaths.some((root) => isInside(root, FIXTURE_ROOT))).toBe(true);
        });
    });

    describe('Deny filter', () => {
        test.each([
            { file: '/repo/.env', denied: true },
            { file: '/repo/app/.env.local', denied: true },
            { file: '/repo/certs/server.PEM', denied: true },
            { file: '/repo/.git/config', denied: true },
            { file: '/repo/src/env.ts', denied: false },
        ])("Should match $file against Vite's default deny list: $denied", ({ file, denied }) => {
            const isDenied = createDenyFilter(['.env', '.env.*', '*.{crt,pem}', '**/.git/**']);
            expect(isDenied(file)).toBe(denied);
        });
    });

    describe('Module load errors', () => {
        const parseFailure = (file: string) => ({
            error: {
                name: 'RollupError',
                message: `Parse failure: Unexpected token (1:4)\nAt file: ${file}\nContents of line 1: SECRET=value`,
                id: file,
                frame: '1: SECRET=value',
                loc: { file, line: 1, column: 4 },
            },
        });
        const refusalOf = (file: string) =>
            file.startsWith('/project/') ? undefined : OUTSIDE_READ_ROOTS_REASON;

        test("Should keep a readable module's error as Vite reported it", () => {
            const response = parseFailure('/project/src/broken.ts');
            expect(guardModuleLoadError(response, refusalOf)).toBe(response);
        });

        test('Should refuse, without its contents, an error about a module outside the readable folders', () => {
            const guarded = guardModuleLoadError(parseFailure('/secrets/key.txt'), refusalOf);
            expect(JSON.stringify(guarded)).not.toContain('SECRET');
            expect(guarded).toEqual(
                unreadableModuleError('/secrets/key.txt', OUTSIDE_READ_ROOTS_REASON),
            );
        });

        test('Should keep only the first line and the code of an error that names no file', () => {
            const response = {
                error: {
                    name: 'Error',
                    message: 'Failed to load url x\nContents of line 1: SECRET=value',
                    code: 'ERR_LOAD_URL',
                    frame: '1: SECRET=value',
                },
            };
            expect(guardModuleLoadError(response, refusalOf)).toEqual({
                error: { name: 'Error', message: 'Failed to load url x', code: 'ERR_LOAD_URL' },
            });
        });

        test('Should pass a successful load through', () => {
            const response = { result: { file: '/project/src/ok.ts', code: '' } };
            expect(guardModuleLoadError(response, refusalOf)).toBe(response);
        });
    });

    describe('Module ids', () => {
        test.each([
            { id: '/@fs/C:/repo/node_modules/a.js', file: 'C:/repo/node_modules/a.js' },
            { id: '/repo/node_modules/a.js?raw', file: '/repo/node_modules/a.js' },
            { id: 'file:///repo/a.js', file: '/repo/a.js' },
            { id: '\0virtual:dd', file: undefined },
            { id: '/@id/__x00__virtual:dd', file: undefined },
            { id: 'node:fs', file: undefined },
        ])('Should read $id as $file', ({ id, file }) => {
            expect(fileOfModuleId(id)).toBe(file);
        });
    });

    describe('Permission model flags', () => {
        const readPaths = ['/project', '/project/node_modules'];
        const tmpDir = '/tmp/dd-apps-exec-1';
        const writePaths = [tmpDir, '/tmp'];
        const node18 = new Set(['--inspect']);
        const node20 = new Set(['--experimental-permission', '--disable-warning']);
        const node24 = new Set(['--permission', '--allow-inspector', '--disable-warning']);
        const node26 = new Set([...node24, '--allow-net']);
        const permissionArgv = (flag: string) => [
            '--disable-warning=ExperimentalWarning',
            flag,
            '--allow-fs-read=/project',
            '--allow-fs-read=/project/node_modules',
            `--allow-fs-read=${tmpDir}`,
            '--allow-fs-read=/tmp',
            `--allow-fs-write=${tmpDir}`,
            '--allow-fs-write=/tmp',
        ];

        test.each([
            {
                description: 'give none on a Node without a permission model',
                nodeFlags: node18,
                inspect: false,
                argv: undefined,
            },
            {
                description: 'use the experimental permission flag on Node 20',
                nodeFlags: node20,
                inspect: false,
                argv: permissionArgv('--experimental-permission'),
            },
            {
                description: 'give none while debugging on Node 20, which has no --allow-inspector',
                nodeFlags: node20,
                inspect: true,
                argv: undefined,
            },
            {
                description: 'keep the permission model while debugging on Node 24',
                nodeFlags: node24,
                inspect: true,
                argv: [...permissionArgv('--permission'), '--allow-inspector'],
            },
            {
                description: 'allow the network on a Node whose permission model covers it',
                nodeFlags: node26,
                inspect: false,
                argv: [...permissionArgv('--permission'), '--allow-net'],
            },
        ])('Should $description', ({ nodeFlags, inspect, argv }) => {
            expect(permissionModelArgv({ readPaths, writePaths, nodeFlags, inspect })).toEqual(
                argv,
            );
        });
    });
});
