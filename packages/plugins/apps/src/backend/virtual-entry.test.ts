// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as shared from '@dd/apps-plugin/backend/shared';
import {
    generateDevVirtualEntryContent,
    generateVirtualEntryContent,
} from '@dd/apps-plugin/backend/virtual-entry';

const PROJECT_ROOT = '/project';

describe('Backend Functions - generateVirtualEntryContent', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    describe('without action-catalog', () => {
        beforeEach(() => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
        });

        test('Should import the function by name from the entry path', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/backend/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).toContain('import { myHandler } from "/src/backend/handler.ts"');
        });

        test('Should export an async main($) function', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).toContain('export async function main($)');
        });

        test('Should set globalThis.$ = $', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).toContain('globalThis.$ = $');
        });

        test('Should include backendFunctionArgs template expression', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            // eslint-disable-next-line no-template-curly-in-string
            expect(result).toContain("JSON.parse('${backendFunctionArgs}'");
        });

        test('Should call the function with spread args', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).toContain('await myHandler(...args)');
        });

        test('Should include the setExecuteActionImplementation bridge snippet', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).toContain('typeof setExecuteActionImplementation');
        });

        test('Should not include action-catalog import', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).not.toContain('@datadog/action-catalog');
        });
    });

    describe('with action-catalog', () => {
        beforeEach(() => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
        });

        test('Should include action-catalog import', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).toContain(
                "import { setExecuteActionImplementation } from '@datadog/action-catalog/action-execution'",
            );
        });

        test('Should still include the bridge snippet', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).toContain('typeof setExecuteActionImplementation');
        });
    });

    test('Should escape entry paths with special characters', () => {
        jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
        const result = generateVirtualEntryContent(
            'handler',
            '/path/with "quotes"/handler.ts',
            PROJECT_ROOT,
        );
        expect(result).toContain('from "/path/with \\"quotes\\"/handler.ts"');
    });
});

describe('Backend Functions - generateDevVirtualEntryContent', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
    });

    test('Should import the function by name from the entry path', () => {
        const result = generateDevVirtualEntryContent('greet', '/src/backend/greet.ts', []);
        expect(result).toContain('import { greet } from "/src/backend/greet.ts"');
    });

    test('Should export an async main($) function', () => {
        const result = generateDevVirtualEntryContent('greet', '/src/greet.ts', []);
        expect(result).toContain('export async function main($)');
    });

    test('Should inline args as JSON instead of template expression', () => {
        const result = generateDevVirtualEntryContent('greet', '/src/greet.ts', ['hello', 42]);
        expect(result).toContain('const args = ["hello",42]');
        // eslint-disable-next-line no-template-curly-in-string
        expect(result).not.toContain('${backendFunctionArgs}');
    });

    test('Should handle empty args array', () => {
        const result = generateDevVirtualEntryContent('greet', '/src/greet.ts', []);
        expect(result).toContain('const args = []');
    });

    test('Should call the function with spread args', () => {
        const result = generateDevVirtualEntryContent('greet', '/src/greet.ts', []);
        expect(result).toContain('await greet(...args)');
    });

    test('Should include action-catalog import when installed', () => {
        jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
        const result = generateDevVirtualEntryContent('greet', '/src/greet.ts', []);
        expect(result).toContain(
            "import { setExecuteActionImplementation } from '@datadog/action-catalog/action-execution'",
        );
    });
});
