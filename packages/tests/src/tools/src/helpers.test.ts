// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getCamelCase,
    getPascalCase,
    getTitle,
    replaceInBetween,
    slugify,
} from '@dd/tools/helpers';

describe('Tools helpers', () => {
    describe('slugify', () => {
        const cases = [
            {
                description: 'convert a string to lowercase',
                input: 'Hello World',
                expectation: 'hello-world',
            },
            {
                description: 'remove accents from characters',
                input: 'Çäfé',
                expectation: 'cafe',
            },
            {
                description: 'replace spaces with hyphens',
                input: 'hello world',
                expectation: 'hello-world',
            },
            {
                description: 'remove special characters',
                input: 'hello@world!',
                expectation: 'helloworld',
            },
            {
                description: 'trim leading and trailing spaces',
                input: '  hello world  ',
                expectation: 'hello-world',
            },
            {
                description: 'handle empty strings',
                input: '',
                expectation: '',
            },
            {
                description: 'handle strings with only special characters',
                input: '!@#$%^&*()',
                expectation: '',
            },
            {
                description: 'handle strings with multiple spaces',
                input: 'hello   world',
                expectation: 'hello-world',
            },
            {
                description: 'handle strings with mixed case and special characters',
                input: 'Hello@World! 123',
                expectation: 'helloworld-123',
            },
        ];
        test.each(cases)('should $description', ({ input, expectation }) => {
            expect(slugify(input)).toBe(expectation);
        });
    });

    describe('replaceInBetween', () => {
        const cases = [
            {
                description: 'should replace content between two markers',
                content: '\n\n',
                mark: '/* MARK */',
                injection: 'Hello World',
                expectation: '/* MARK */\nHello World\n/* MARK */',
            },
            {
                description: 'should handle multiple lines between markers',
                content: 'Line 1\nLine 2\n',
                mark: '/* MARK */',
                injection: 'New Line 1\nNew Line 2',
                expectation: '/* MARK */\nNew Line 1\nNew Line 2\n/* MARK */',
            },
            {
                description: 'should handle special characters in markers',
                content: '\n\n',
                mark: '<!-- M@RK -->',
                injection: 'Hello World',
                expectation: '<!-- M@RK -->\nHello World\n<!-- M@RK -->',
            },
            {
                description: 'should handle no content between markers',
                content: '',
                mark: '{{MARK}}',
                injection: 'Hello World',
                expectation: '{{MARK}}\nHello World\n{{MARK}}',
            },
            {
                description: 'should handle markers with regex special characters',
                content: '\n\n',
                mark: '/* M*\\/.K */',
                injection: 'Hel$lo $$World $100',
                expectation: '/* M*\\/.K */\nHel$lo $$World $100\n/* M*\\/.K */',
            },
        ];

        test.each(cases)('should $description', ({ content, mark, injection, expectation }) => {
            const fullContent = `${mark}${content}${mark}`;
            expect(replaceInBetween(fullContent, mark, injection)).toBe(expectation);
        });
    });

    describe('getTitle', () => {
        const cases = [
            {
                description: 'convert a string to title case',
                input: 'hello-world',
                expectation: 'Hello World',
            },
            {
                description: 'handle strings with multiple hyphens',
                input: 'hello-world-123',
                expectation: 'Hello World 123',
            },
            {
                description: 'handle strings with special characters',
                input: 'hello-world@123',
                expectation: 'Hello World@123',
            },
            {
                description: 'handle strings with mixed case',
                input: 'HelLo---WORLD',
                expectation: 'Hello World',
            },
            {
                description: 'handle empty strings',
                input: '',
                expectation: '',
            },
        ];

        test.each(cases)('should $description', ({ input, expectation }) => {
            expect(getTitle(input)).toBe(expectation);
        });
    });

    describe('getPascaleCase', () => {
        const cases = [
            {
                description: 'convert a string to PascalCase',
                input: 'hello-world',
                expectation: 'HelloWorld',
            },
            {
                description: 'handle strings with multiple hyphens',
                input: 'hello-world-123',
                expectation: 'HelloWorld123',
            },
            {
                description: 'handle strings with special characters',
                input: 'hello-world@123',
                expectation: 'HelloWorld@123',
            },
            {
                description: 'handle strings with mixed case',
                input: 'HelLo---WORLD',
                expectation: 'HelloWorld',
            },
            {
                description: 'handle empty strings',
                input: '',
                expectation: '',
            },
        ];

        test.each(cases)('should $description', ({ input, expectation }) => {
            expect(getPascalCase(input)).toBe(expectation);
        });
    });

    describe('getCamelCase', () => {
        const cases = [
            {
                description: 'convert a string to camelCase',
                input: 'hello-world',
                expectation: 'helloWorld',
            },
            {
                description: 'handle strings with multiple hyphens',
                input: 'hello-world-123',
                expectation: 'helloWorld123',
            },
            {
                description: 'handle strings with special characters',
                input: 'hello-world@123',
                expectation: 'helloWorld@123',
            },
            {
                description: 'handle strings with mixed case',
                input: 'HelLo---WORLD',
                expectation: 'helloWorld',
            },
            {
                description: 'handle empty strings',
                input: '',
                expectation: '',
            },
        ];

        test.each(cases)('should $description', ({ input, expectation }) => {
            expect(getCamelCase(input)).toBe(expectation);
        });
    });
});
