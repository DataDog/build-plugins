// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseParams } from '@dd/tools/commands/integrity/files';

describe('files.ts', () => {
    describe('parseParams', () => {
        const expectations = [
            {
                st: `function named (arg1) {
  console.log("Some content");
}`,
                expected: ['arg1'],
                description: 'basic named function with 1 argument',
            },
            {
                st: `function named ( arg1, arg2 ) {
    console.log("Some content");
}`,
                expected: ['arg1', 'arg2'],
                description: 'basic named function with 2 arguments and spaces',
            },
            {
                st: `const myFn = ( arg1 , arg2 ) => {
    console.log("Some content");
};`,
                expected: ['arg1', 'arg2'],
                description: 'basic arrow function with 2 arguments and spaces',
            },
            {
                st: `function weird (
    arg1,
    arg2, // Some comment.
// Some other comment.
    arg3,
) {
    console.log("Some content");
}`,
                expected: ['arg1', 'arg2', 'arg3'],
                description: 'weird named function with comments and spaces',
            },
        ];

        test.each(expectations)('Should parse $description.', ({ st, expected }) => {
            const result = parseParams(st);
            expect(result).toEqual(expected);
        });
    });
});
