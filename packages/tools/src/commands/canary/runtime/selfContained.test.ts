// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, readFile, rm } from '@dd/core/helpers/fs';
import { execFile } from 'child_process';
import { glob } from 'glob';
import os from 'os';
import { outdent } from 'outdent';
import path from 'path';
import { promisify } from 'util';

const ENGINE_DIRECTORY = __dirname;
const COPY_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-engine-${process.pid}`);
// import/export ... from '...', import '...', and import('...').
const SPECIFIER = /\b(?:from|import)\s*\(?\s*'([^']+)'/g;
const ALLOWED_SPECIFIER = /^(node:[\w/]+|\.\/[\w-]+\.ts)$/;
const execFileAsync = promisify(execFile);

const getEngineFiles = async (): Promise<string[]> => {
    const files = await glob('*.ts', { cwd: ENGINE_DIRECTORY, ignore: '*.test.ts' });
    return files.sort();
};

const getNodeArguments = (): string[] => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    // Node.js strips types by default from 22.18 on.
    const stripsByDefault = major > 22 || (major === 22 && minor >= 18);
    return stripsByDefault ? [] : ['--experimental-strip-types'];
};

describe('runtime engine', () => {
    afterAll(async () => {
        await rm(COPY_ROOT);
    });

    test('should import only Node.js built-ins and its own files', async () => {
        const files = await getEngineFiles();
        const specifiers: string[] = [];
        for (const file of files) {
            const filePath = path.resolve(ENGINE_DIRECTORY, file);
            const content = await readFile(filePath);
            for (const match of content.matchAll(SPECIFIER)) {
                specifiers.push(`${file}: ${match[1]}`);
            }
        }

        expect(files).toContain('index.ts');
        expect(specifiers.length).toBeGreaterThan(0);
        const disallowed = specifiers.filter((entry) => {
            const specifier = entry.split(': ')[1] ?? '';
            return !ALLOWED_SPECIFIER.test(specifier);
        });
        expect(disallowed).toEqual([]);
    });

    test('should run from a copy with plain Node.js and nothing installed', async () => {
        const files = await getEngineFiles();
        for (const file of files) {
            const sourcePath = path.resolve(ENGINE_DIRECTORY, file);
            const content = await readFile(sourcePath);
            const copyPath = path.resolve(COPY_ROOT, 'engine', file);
            await outputFile(copyPath, content);
        }
        const packagePath = path.resolve(COPY_ROOT, 'package.json');
        const sitePath = path.resolve(COPY_ROOT, 'site/assets/app-a1B2c3D4.js');
        const scriptPath = path.resolve(COPY_ROOT, 'check.ts');
        await outputFile(packagePath, '{ "type": "module" }\n');
        await outputFile(sitePath, 'console.log("app");\n');
        // Exercises the server and the statistics, which need no browser.
        await outputFile(
            scriptPath,
            outdent`
                import { compareMedians, createRandom, startStaticServer } from './engine/index.ts';

                const server = await startStaticServer({ immutablePaths: /^\\/assets\\//, root: 'site' });
                const response = await fetch(server.origin + '/assets/app-a1B2c3D4.js');
                await server.close();
                const comparison = compareMedians({
                    control: [10, 11, 12],
                    instrumented: [20, 21, 22],
                    random: createRandom('seed'),
                    resamples: 10,
                });
                console.log(JSON.stringify({
                    cacheControl: response.headers.get('cache-control'),
                    delta: comparison?.delta,
                }));
            `,
        );

        const nodeArguments = getNodeArguments();
        const { stdout } = await execFileAsync(process.execPath, [...nodeArguments, 'check.ts'], {
            cwd: COPY_ROOT,
            env: { PATH: process.env.PATH },
        });
        const output: unknown = JSON.parse(stdout);

        expect(output).toEqual({
            cacheControl: 'public, max-age=31536000, immutable',
            delta: 10,
        });
    });
});
