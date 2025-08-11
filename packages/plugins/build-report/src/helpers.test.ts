// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import {
    cleanPath,
    cleanName,
    getType,
    removeCommonPrefix,
} from '@dd/internal-build-report-plugin/helpers';
import { getContextMock, getMockBuildReport } from '@dd/tests/_jest/helpers/mocks';

describe('Build report plugin helpers', () => {
    describe('getType', () => {
        const expectations = [
            {
                name: 'unknown',
                filepath: 'unknown',
                expected: 'unknown',
            },
            {
                name: 'webpack runtime',
                filepath: 'webpack/runtime',
                expected: 'runtime',
            },
            {
                name: 'file with extension',
                filepath: 'path/to/file.js',
                expected: 'js',
            },
            {
                name: 'complex loader path',
                filepath:
                    '/loaders/load.js??ref--4-0!/tests/_virtual_.%2Fsrc%2Ffixtures%2Fproject%2Fmain1.js%3Fadd-custom-injection',
                expected: 'js',
            },
        ];
        test.each(expectations)(
            'Should return the right type for "$name".',
            ({ filepath, expected }) => {
                expect(getType(filepath)).toBe(expected);
            },
        );
    });

    describe('removeCommonPrefix', () => {
        const expectations = [
            {
                name: 'no common prefix',
                filepath1: '/path/to/file1.js',
                filepath2: '/different/directory/file2.js',
                expected: '/path/to/file1.js',
            },
            {
                name: 'common root directory',
                filepath1: '/common/path/to/file1.js',
                filepath2: '/common/different/file2.js',
                expected: '/path/to/file1.js',
            },
            {
                name: 'identical paths',
                filepath1: '/path/to/file.js',
                filepath2: '/path/to/file.js',
                expected: '',
            },
            {
                name: 'nested common directories',
                filepath1: '/common/nested/path/to/file1.js',
                filepath2: '/common/nested/different/file2.js',
                expected: '/path/to/file1.js',
            },
            {
                name: 'partial directory name match',
                filepath1: '/path/to/subdirectory/file1.js',
                filepath2: '/path/different/directory/file2.js',
                expected: '/to/subdirectory/file1.js',
            },
        ];
        test.each(expectations)(
            'Should correctly remove common prefix for "$name".',
            ({ filepath1, filepath2, expected }) => {
                expect(removeCommonPrefix(filepath1, filepath2)).toBe(expected);
            },
        );
    });

    describe('cleanName', () => {
        const expectations = [
            {
                name: 'injected file',
                filepath: `./${INJECTED_FILE}`,
                expected: INJECTED_FILE,
            },
            {
                name: 'unknown file',
                filepath: 'unknown',
                expected: 'unknown',
            },
            {
                name: 'webpack runtime',
                filepath: 'webpack/runtime/make namespace object',
                expected: 'make-namespace-object',
            },
            {
                name: 'loader path',
                filepath:
                    'webpack/loaders/load.js??ruleSet[1].rules[0].use[0]!/current/working/directory/path.js',
                expected: 'path.js',
            },
            {
                name: 'buildRoot',
                filepath: '/current/working/directory/src/path.js',
                expected: 'src/path.js',
            },
            {
                name: 'outDir',
                filepath: '/current/working/directory/dist/path.js',
                expected: 'path.js',
            },
            {
                name: 'node_modules dependency',
                filepath: '/current/working/directory/node_modules/module/path.js',
                expected: 'module/path.js',
            },
            {
                name: 'query parameters',
                filepath: '/current/working/directory/path.js?query=param',
                expected: 'path.js',
            },
            {
                name: 'encoded query parameters',
                filepath: '/current/working/directory/path.js%3Fquery=param',
                expected: 'path.js',
            },
            {
                name: 'pipe query parameters',
                filepath: '/current/working/directory/path.js|query=param',
                expected: 'path.js',
            },
            {
                name: 'leading dots and slashes',
                filepath: '../../path.js',
                expected: 'path.js',
            },
            {
                name: 'some composition',
                filepath:
                    'webpack/loaders/load.js??ruleSet[1].rules[0].use[0]!/current/working/directory/node_modules/module/path.js?query=param',
                expected: 'module/path.js',
            },
        ];
        test.each(expectations)(
            'Should return a cleaned name for "$name".',
            ({ filepath, expected }) => {
                const context = getContextMock({
                    buildRoot: '/current/working/directory',
                    bundler: {
                        ...getMockBuildReport().bundler,
                        outDir: '/current/working/directory/dist',
                    },
                });
                expect(cleanName(context.bundler.outDir, filepath)).toBe(expected);
            },
        );
    });

    describe('cleanPath', () => {
        const expectations = [
            {
                name: 'loader path',
                filepath:
                    'webpack/loaders/load.js??ruleSet[1].rules[0].use[0]!/current/working/directory/path.js',
                expected: '/current/working/directory/path.js',
            },
            {
                name: 'query parameters',
                filepath: '/current/working/directory/path.js?query=param',
                expected: '/current/working/directory/path.js',
            },
            {
                name: 'encoded query parameters',
                filepath: '/current/working/directory/path.js%3Fquery=param',
                expected: '/current/working/directory/path.js',
            },
            {
                name: 'pipe query parameters',
                filepath: '/current/working/directory/path.js|query=param',
                expected: '/current/working/directory/path.js',
            },
            {
                name: 'leading invisible characters',
                filepath: '\u0000/current/working/directory/path.js',
                expected: '/current/working/directory/path.js',
            },
            {
                name: 'some composition',
                filepath:
                    '\u0000/webpack/loaders/load.js??ruleSet[1].rules[0].use[0]!/current/working/directory/node_modules/module/path.js?query=param',
                expected: '/current/working/directory/node_modules/module/path.js',
            },
        ];
        test.each(expectations)(
            'Should return a cleaned path for "$name".',
            ({ filepath, expected }) => {
                expect(cleanPath(filepath)).toBe(expected);
            },
        );
    });
});
