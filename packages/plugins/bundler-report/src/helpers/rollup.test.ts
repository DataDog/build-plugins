// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { addFixtureFiles } from '@dd/tests/_jest/helpers/mocks';
import type { InputOptions } from 'rollup';

import { computeCwd, getOutDirFromOutputs } from './rollup';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        existsSync: jest.fn(),
    };
});

describe('Rollup Helpers', () => {
    describe('getOutDirFromOutputs', () => {
        const cases = [
            {
                description: 'extract dir from single output object with dir',
                outputOptions: { dir: 'dist' },
                expected: 'dist',
            },
            {
                description: 'extract dir from single output object with file',
                outputOptions: { file: 'dist/bundle.js' },
                expected: 'dist',
            },
            {
                description: 'extract dir from array of outputs with dir',
                outputOptions: [{ dir: 'dist' }, { dir: 'dist2' }],
                expected: 'dist',
            },
            {
                description: 'extract dir from array of outputs with file',
                outputOptions: [{ file: 'dist/bundle.js' }, { file: 'dist2/bundle.js' }],
                expected: 'dist',
            },
            {
                description: 'prefer dir over file in same output',
                outputOptions: { dir: 'dist', file: 'other/bundle.js' },
                expected: 'dist',
            },
            {
                description: 'handle nested file paths',
                outputOptions: { file: 'dist/assets/js/bundle.js' },
                expected: 'dist/assets/js',
            },
            {
                description: 'return undefined for no outputOptions',
                outputOptions: undefined,
                expected: undefined,
            },
            {
                description: 'return undefined for empty array',
                outputOptions: [],
                expected: undefined,
            },
            {
                description: 'return undefined when no dir or file specified',
                outputOptions: [{ format: 'esm' }, { format: 'cjs' }],
                expected: undefined,
            },
        ];

        test.each(cases)('Should $description', ({ outputOptions, expected }) => {
            // Rollup doesn't type InputOptions['output'], yet it exists.
            expect(getOutDirFromOutputs({ output: outputOptions } as InputOptions)).toBe(expected);
        });
    });

    describe('computeCwd', () => {
        beforeAll(() => {
            jest.spyOn(process, 'cwd').mockReturnValue('/base/cwd');
        });

        beforeEach(() => {
            // Set up virtual file system for package.json files
            addFixtureFiles({
                '/project/package.json': '',
                '/project/src/package.json': '',
                '/project/lib/package.json': '',
                '/base/cwd/package.json': '',
            });
        });

        const cases = [
            {
                description: 'handle string input',
                options: { input: '/project/src/index.js' },
                expected: '/project',
            },
            {
                description: 'handle array input',
                options: {
                    input: ['/project/src/index.js', '/project/lib/util.js'],
                },
                expected: '/project',
            },
            {
                description: 'handle object input',
                options: {
                    input: {
                        main: '/project/src/index.js',
                        util: '/project/lib/util.js',
                    },
                },
                expected: '/project',
            },
            {
                description: 'throw error for invalid input type in object',
                options: { input: { main: 123 } },
                shouldThrow: 'Invalid input type',
            },
            {
                description: 'throw error for invalid input type in array',
                options: { input: [123] },
                shouldThrow: 'Invalid input type',
            },
            {
                description: 'include absolute output directory in cwd computation',
                options: {
                    input: '/project/src/index.js',
                    output: { dir: '/project/dist' },
                },
                expected: '/project',
            },
            {
                description: 'ignore relative output directory',
                options: {
                    input: '/project/src/index.js',
                    output: { dir: 'dist' },
                },
                expected: '/project',
            },
            {
                description: 'fallback to process.cwd when no input',
                options: {},
                expected: '/base/cwd',
            },
            {
                description: 'fallback to process.cwd with relative input',
                options: { input: 'index.js' },
                expected: '/base/cwd',
            },
        ];

        test.each(cases)('Should $description', ({ options, expected, shouldThrow }) => {
            const errors = [];
            const results = [];
            const expectedResults = expected ? [expected] : [];
            const expectedErrors = shouldThrow ? [shouldThrow] : [];

            try {
                // Rollup doesn't type InputOptions['output'], yet it exists.
                const result = computeCwd(options as InputOptions);
                results.push(result);
            } catch (error: any) {
                errors.push(error.message);
            }

            expect(errors).toEqual(expectedErrors);
            expect(results).toEqual(expectedResults);
        });
    });
});
