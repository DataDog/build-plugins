// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { mkdir, outputFile, rm } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import fsp from 'fs/promises';
import path from 'path';

import {
    getFunctionIdPath,
    isInsideDirectory,
    isOutsideRoot,
    resolveYarnVirtualPath,
    stripQuery,
} from './paths';

// A path that doesn't exist, so resolving symlinks leaves paths in it unchanged.
const REPOSITORY_ROOT = '/does-not-exist/repo';

describe('stripQuery', () => {
    const cases = [
        { description: 'keep a path without a query', input: 'src/a.js', expected: 'src/a.js' },
        {
            description: 'remove a loader query',
            input: 'src/a.js?inline',
            expected: 'src/a.js',
        },
        {
            description: 'remove a Vue single-file component query',
            input: 'src/Cart.vue?vue&type=script&lang.ts',
            expected: 'src/Cart.vue',
        },
    ];

    test.each(cases)('Should $description.', ({ input, expected }) => {
        expect(stripQuery(input)).toBe(expected);
    });
});

describe('resolveYarnVirtualPath', () => {
    const cases = [
        {
            description: 'keep a regular path',
            input: '/repo/packages/a/index.js',
            expected: '/repo/packages/a/index.js',
        },
        {
            description: 'resolve a web-ui workspace package',
            input: '/web-ui/.yarn/__virtual__/hash-05a436a78a514e39/1/packages/apps/databases/toolkit/group.ts',
            expected: '/web-ui/packages/apps/databases/toolkit/group.ts',
        },
        {
            description: 'go up as many levels as the depth',
            input: '/repo/sub/.yarn/__virtual__/pkg-virtual-abc/2/packages/a.js',
            expected: '/repo/packages/a.js',
        },
        {
            description: 'stay in the virtual folder parent with a depth of 0',
            input: '/repo/.yarn/__virtual__/pkg-virtual-abc/0/cache/a.js',
            expected: '/repo/.yarn/cache/a.js',
        },
        {
            description: 'resolve the name used by older Yarn versions',
            input: '/repo/.yarn/$$virtual/pkg-virtual-abc/1/packages/a.js',
            expected: '/repo/packages/a.js',
        },
        {
            description: 'resolve nested virtual paths',
            input: '/repo/.yarn/__virtual__/a-virtual-1/1/.yarn/__virtual__/b-virtual-2/1/packages/b.js',
            expected: '/repo/packages/b.js',
        },
    ];

    test.each(cases)('Should $description.', ({ input, expected }) => {
        expect(resolveYarnVirtualPath(input)).toBe(expected);
    });
});

describe('getFunctionIdPath', () => {
    const cases = [
        {
            description: 'make a path relative to the repository root',
            input: `${REPOSITORY_ROOT}/app/src/a.js`,
            expected: 'app/src/a.js',
        },
        {
            description: 'strip the query string',
            input: `${REPOSITORY_ROOT}/app/src/Cart.vue?vue&type=script`,
            expected: 'app/src/Cart.vue',
        },
        {
            description: 'resolve a Yarn virtual path',
            input: `${REPOSITORY_ROOT}/.yarn/__virtual__/lib-virtual-abc/1/packages/lib/index.js`,
            expected: 'packages/lib/index.js',
        },
        {
            description: 'keep a file outside the repository outside',
            input: '/does-not-exist/shared/index.js',
            expected: '../shared/index.js',
        },
    ];

    test.each(cases)('Should $description.', ({ input, expected }) => {
        expect(getFunctionIdPath(input, REPOSITORY_ROOT)).toBe(expected);
    });

    describe('with symlinks', () => {
        let workingDir: string;
        let repositoryRoot: string;

        beforeAll(async () => {
            const seed = `${Math.abs(jest.getSeed())}.function-id-path.${Date.now()}`;
            workingDir = getTempWorkingDir(seed);
            repositoryRoot = path.resolve(workingDir, 'repo');
            const packageDir = path.resolve(repositoryRoot, 'packages/lib');
            const packageFile = path.resolve(packageDir, 'index.js');
            await outputFile(packageFile, 'export const lib = 1;');

            // A link inside the repository, like a workspace package in node_modules.
            const insideLink = path.resolve(repositoryRoot, 'app/node_modules/lib');
            const insideLinkDir = path.dirname(insideLink);
            await mkdir(insideLinkDir);
            await fsp.symlink(packageDir, insideLink, 'dir');

            // A link outside the repository.
            const outsideLink = path.resolve(workingDir, 'linked-lib');
            await fsp.symlink(packageDir, outsideLink, 'dir');
        });

        afterAll(async () => {
            await rm(workingDir);
        });

        const symlinkCases = [
            {
                description: 'resolve a link outside the repository to its target',
                input: 'linked-lib/index.js',
                expected: 'packages/lib/index.js',
            },
            {
                description: 'keep the path of a link inside the repository',
                input: 'repo/app/node_modules/lib/index.js',
                expected: 'app/node_modules/lib/index.js',
            },
        ];

        test.each(symlinkCases)('Should $description.', ({ input, expected }) => {
            const moduleId = path.resolve(workingDir, input);
            expect(getFunctionIdPath(moduleId, repositoryRoot)).toBe(expected);
        });
    });
});

describe('isOutsideRoot', () => {
    const cases = [
        { description: 'accept a nested path', input: 'src/a.js', expected: false },
        { description: 'accept a name starting with dots', input: '..a.js', expected: false },
        { description: 'reject a parent path', input: '../a.js', expected: true },
        { description: 'reject a Windows parent path', input: '..\\a.js', expected: true },
        { description: 'reject the parent directory', input: '..', expected: true },
        { description: 'reject an absolute path', input: '/repo/a.js', expected: true },
    ];

    test.each(cases)('Should $description.', ({ input, expected }) => {
        expect(isOutsideRoot(input)).toBe(expected);
    });
});

describe('isInsideDirectory', () => {
    const cases = [
        { description: 'accept a nested file', input: '/out/dir/a.json', expected: true },
        { description: 'reject a sibling file', input: '/out/a.json', expected: false },
        {
            description: 'reject a directory that only shares a prefix',
            input: '/out/dir-2/a.json',
            expected: false,
        },
    ];

    test.each(cases)('Should $description.', ({ input, expected }) => {
        expect(isInsideDirectory(input, '/out/dir')).toBe(expected);
    });
});
