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
            jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(false);
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

        test('Should read args from $.backendFunctionArgs (no source-text substitution)', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).toContain('const args = $.backendFunctionArgs ?? [];');
            // The previous design textually substituted args into a single-quoted
            // string literal, which allowed `'` in user input to break out and
            // inject arbitrary JS. The generated script must never wrap a host
            // template expression inside a quoted string.
            // eslint-disable-next-line no-template-curly-in-string
            expect(result).not.toContain('${backendFunctionArgs}');
            expect(result).not.toContain('JSON.parse(');
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

        test('Should not include Datadog Apps backend context setup', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            expect(result).not.toContain('@datadog/apps-backend/runtime');
            expect(result).not.toContain('setBackend(buildRuntimeFromJsFunctionWithActions($))');
        });
    });

    describe('with action-catalog', () => {
        beforeEach(() => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(false);
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

    describe('with @datadog/apps-backend', () => {
        beforeEach(() => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
            jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(true);
        });

        test('Should import and set the backend context before calling the handler', () => {
            const result = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );

            expect(result).toContain(
                "import { buildRuntimeFromJsFunctionWithActions } from '@datadog/apps-backend/runtime/jsFunctionWithActions'",
            );
            expect(result).toContain("import { setBackend } from '@datadog/apps-backend/runtime'");
            expect(
                result.indexOf('setBackend(buildRuntimeFromJsFunctionWithActions($))'),
            ).toBeGreaterThan(result.indexOf('globalThis.$ = $'));
            expect(result.indexOf('await myHandler(...args)')).toBeGreaterThan(
                result.indexOf('setBackend(buildRuntimeFromJsFunctionWithActions($))'),
            );
        });
    });

    test('Should escape entry paths with special characters', () => {
        jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
        jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(false);
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
        jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(false);
    });

    test('Should produce identical output to generateVirtualEntryContent', () => {
        // Dev and prod share the same runtime contract ($.backendFunctionArgs),
        // so the dev codegen must produce the same source as production.
        const dev = generateDevVirtualEntryContent('greet', '/src/greet.ts', PROJECT_ROOT);
        const prod = generateVirtualEntryContent('greet', '/src/greet.ts', PROJECT_ROOT);
        expect(dev).toBe(prod);
    });

    test('Should read args from $.backendFunctionArgs', () => {
        const result = generateDevVirtualEntryContent('greet', '/src/greet.ts', PROJECT_ROOT);
        expect(result).toContain('const args = $.backendFunctionArgs ?? [];');
        // eslint-disable-next-line no-template-curly-in-string
        expect(result).not.toContain('${backendFunctionArgs}');
    });
});

/**
 * The bug being fixed: previously, args were substituted as JSON text into a
 * single-quoted JS string literal. Any string arg containing `'` broke out of
 * the literal — both a runtime parser error and a code-injection vector.
 *
 * These tests evaluate the generated `main` function against adversarial
 * inputs to confirm values now round-trip losslessly via the $ context.
 */
describe('Backend Functions - args round-trip via $.backendFunctionArgs', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
        jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(false);
    });

    // Extract the body of the generated `main($)` function so we can eval it
    // directly with a custom $ that includes a mocked handler import.
    function buildMainFromSource(source: string, handler: (...args: unknown[]) => unknown) {
        // The generated source has `import { handler } from "..."` at the top,
        // which we can't execute outside a module system. Strip imports and
        // inject the handler via $ instead.
        const body = source
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('import '))
            .join('\n')
            // Replace the call site with a $-bound handler we control.
            .replace(/await myHandler\(\.\.\.args\)/, 'await $.__handler(...args)');
        // The generated code declares globalThis.$, which has no effect in this
        // sandbox but is harmless. Wrap the body so we can return main().
        const wrapper = `${body}\nreturn main($);`;
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const fn = new Function(
            '$',
            wrapper.replace(/export async function main/, 'async function main'),
        );
        return ($: Record<string, unknown>) => fn({ ...$, __handler: handler });
    }

    const adversarialInputs = [
        { description: 'single quote', value: "don't break" },
        { description: 'double quote', value: 'has "quotes" in it' },
        { description: 'backslash', value: 'C:\\path\\to\\file' },
        // eslint-disable-next-line no-template-curly-in-string
        { description: 'template-literal syntax', value: '${alert(1)}' },
        { description: 'newlines and tabs', value: 'line1\nline2\tcol' },
        { description: 'emoji', value: '😀' },
        { description: 'injection attempt', value: "'); alert(1); //" },
    ];

    test.each(adversarialInputs)(
        'Should pass $description through unchanged',
        async ({ value }) => {
            const source = generateVirtualEntryContent(
                'myHandler',
                '/src/handler.ts',
                PROJECT_ROOT,
            );
            let received: unknown;
            const handler = (arg: unknown) => {
                received = arg;
                return 'ok';
            };
            const main = buildMainFromSource(source, handler);
            const result = await main({ backendFunctionArgs: [value] });
            expect(received).toBe(value);
            expect(result).toBe('ok');
        },
    );

    test('Should default to [] when backendFunctionArgs is absent', async () => {
        const source = generateVirtualEntryContent('myHandler', '/src/handler.ts', PROJECT_ROOT);
        let received: unknown[] | undefined;
        const handler = (...args: unknown[]) => {
            received = args;
            return 'ok';
        };
        const main = buildMainFromSource(source, handler);
        await main({});
        expect(received).toEqual([]);
    });
});
