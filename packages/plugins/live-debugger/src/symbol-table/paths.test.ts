// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    createSourceFileResolver,
    isInsideDirectory,
    resolveYarnVirtualPath,
    stripQuery,
} from './paths';

// Paths that don't exist, so resolving symlinks leaves them unchanged.
const REPOSITORY_ROOT = '/does-not-exist/repo';
const BUILD_ROOT = `${REPOSITORY_ROOT}/app`;

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

describe('createSourceFileResolver', () => {
    const cases = [
        {
            description: 'make a path relative to the repository root',
            input: 'src/a.js',
            expected: 'app/src/a.js',
        },
        {
            description: 'strip the query string',
            input: 'src/Cart.vue?vue&type=script',
            expected: 'app/src/Cart.vue',
        },
        {
            description: 'resolve a workspace package outside the build root',
            input: '../packages/lib/index.js',
            expected: 'packages/lib/index.js',
        },
        {
            description: 'resolve a Yarn virtual path',
            input: '../.yarn/__virtual__/lib-virtual-abc/1/packages/lib/index.js',
            expected: 'packages/lib/index.js',
        },
        {
            description: 'leave out a file outside the repository',
            input: '../../shared/index.js',
            expected: undefined,
        },
    ];

    test.each(cases)('Should $description.', ({ input, expected }) => {
        const resolveSourceFile = createSourceFileResolver(BUILD_ROOT, REPOSITORY_ROOT);
        expect(resolveSourceFile(input)).toBe(expected);
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
