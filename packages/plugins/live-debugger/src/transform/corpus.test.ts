// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFileSync } from '@dd/core/helpers/fs';
import {
    annotateCalls,
    countAnnotatedCalls,
    getIntroducedUnreachableCode,
} from '@dd/tests/_jest/helpers/transformInvariants';
import { globSync } from 'glob';
import path from 'path';

import { transformCode } from './index';
import type { TransformOptions } from './index';

// Published code of the plugin's own dependencies: real-world JavaScript with many
// guard clauses and call shapes, pinned by the lockfile. Unit tests cover the
// shapes we thought of; this covers the ones we did not.
const CORPUS_PACKAGES = [
    '@babel/traverse',
    'magic-string',
    '@jridgewell/trace-mapping',
    'picomatch',
];

const BASE_OPTIONS: Omit<TransformOptions, 'code' | 'filePath' | 'buildRoot'> = {
    honorSkipComments: true,
    functionTypes: undefined,
    namedOnly: false,
    decorators: 'legacy',
    exceptionReplay: false,
};

const getCorpusFiles = (): { description: string; filePath: string; packageRoot: string }[] => {
    return CORPUS_PACKAGES.flatMap((packageName) => {
        const packageJsonPath = require.resolve(`${packageName}/package.json`);
        const packageRoot = path.dirname(packageJsonPath);
        const filePaths = globSync('**/*.{js,mjs,cjs}', {
            cwd: packageRoot,
            absolute: true,
            ignore: ['node_modules/**', '**/*.min.js'],
        });
        return filePaths.sort().map((filePath) => {
            const relativePath = path.relative(packageRoot, filePath);
            return { description: `${packageName}/${relativePath}`, filePath, packageRoot };
        });
    });
};

describe('transformCode on real-world code', () => {
    const corpusFiles = getCorpusFiles();

    test('should find the corpus', () => {
        expect(corpusFiles.length).toBeGreaterThan(CORPUS_PACKAGES.length);
    });

    // The calls get PURE annotations first, so each file also checks that every
    // annotation stays in front of its call wherever the transform inserts code.
    test.each(corpusFiles)(
        'should keep the behavior of $description',
        ({ filePath, packageRoot }) => {
            const source = readFileSync(filePath);
            const code = annotateCalls(source);
            const result = transformCode({
                ...BASE_OPTIONS,
                code,
                filePath,
                buildRoot: packageRoot,
            });

            expect(result.failedCount).toBe(0);
            expect(getIntroducedUnreachableCode(code, result.code)).toEqual([]);
            expect(countAnnotatedCalls(result.code)).toBe(countAnnotatedCalls(code));
        },
    );
});
