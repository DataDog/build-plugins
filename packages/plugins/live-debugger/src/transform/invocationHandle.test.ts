// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { runInNewContext } from 'vm';

import { transformCode } from './index';
import type { TransformOptions } from './index';

const BASE_OPTIONS: Omit<TransformOptions, 'code'> = {
    filePath: '/src/utils.ts',
    buildRoot: '/',
    honorSkipComments: false,
    functionTypes: undefined,
    namedOnly: false,
    decorators: 'legacy',
};

/**
 * Opaque per-invocation handle returned by `$dd_entry`.
 *
 * The generated code never inspects it, so the shape here only needs to be
 * identifiable: the tests assert that the exact object handed back by
 * `$dd_entry` is the one every exit hook receives.
 */
interface InvocationHandle {
    id: number;
    enteredWith: Record<string, unknown> | undefined;
}

interface EntryRecord {
    handle: InvocationHandle;
    args: Record<string, unknown> | undefined;
}

interface ExitRecord {
    kind: 'return' | 'throw';
    handle: InvocationHandle | undefined;
    value: unknown;
    locals: Record<string, unknown> | undefined;
}

interface ProbeRuntime {
    entries: EntryRecord[];
    exits: ExitRecord[];
}

type EntryHook = (
    probes: unknown,
    self: unknown,
    args?: Record<string, unknown>,
) => InvocationHandle | undefined;

interface RuntimeHooks {
    $dd_probes: (functionId: string) => unknown;
    $dd_entry: EntryHook;
    $dd_return: (
        handle: unknown,
        value: unknown,
        self: unknown,
        args?: Record<string, unknown>,
        locals?: Record<string, unknown>,
    ) => unknown;
    $dd_throw: (
        handle: unknown,
        error: unknown,
        self: unknown,
        args?: Record<string, unknown>,
    ) => void;
}

/**
 * Stand-in for the Browser Debugger SDK implementing the Option A contract:
 * `$dd_probes` looks probes up, `$dd_entry` exchanges them for a handle that
 * identifies one invocation, and the exit hooks are given that handle back.
 *
 * `producesHandle: false` models an invocation where every probe was skipped
 * (sampling, entry condition, lifetime budget). `$dd_entry` then returns
 * undefined and the generated guards must skip the exit hooks entirely.
 */
const createProbeRuntime = (
    producesHandle: boolean,
): { runtime: ProbeRuntime; hooks: RuntimeHooks } => {
    const runtime: ProbeRuntime = { entries: [], exits: [] };
    let nextHandleId = 0;

    const hooks: RuntimeHooks = {
        $dd_probes: () => ['probe'],
        $dd_entry: (probes, self, args) => {
            if (!producesHandle) {
                return undefined;
            }
            const handle: InvocationHandle = { id: nextHandleId, enteredWith: args };
            nextHandleId += 1;
            runtime.entries.push({ handle, args });
            return handle;
        },
        $dd_return: (handle, value, self, args, locals) => {
            const record: ExitRecord = {
                kind: 'return',
                handle: handle as InvocationHandle | undefined,
                value,
                locals,
            };
            runtime.exits.push(record);
            return value;
        },
        $dd_throw: (handle, error, self, args) => {
            const record: ExitRecord = {
                kind: 'throw',
                handle: handle as InvocationHandle | undefined,
                value: error,
                locals: undefined,
            };
            runtime.exits.push(record);
        },
    };

    return { runtime, hooks };
};

interface RunResult {
    runtime: ProbeRuntime;
    output: Record<string, unknown>;
}

/**
 * Transform `code`, then execute it against a stubbed probe runtime.
 *
 * `script` runs after the transformed code and writes whatever the test needs
 * to inspect onto `out`. Host helpers (`wait`, `settle`) are exposed as globals
 * so async tests can control settlement order without timers.
 */
const runInstrumented = (
    code: string,
    script: string,
    producesHandle: boolean,
    helpers: Record<string, unknown> = {},
): RunResult => {
    const transformed = transformCode({ ...BASE_OPTIONS, code });
    const { runtime, hooks } = createProbeRuntime(producesHandle);
    const output: Record<string, unknown> = {};
    const sandbox = { ...hooks, ...helpers, out: output };

    runInNewContext(`${transformed.code}\n${script}`, sandbox);

    return { runtime, output };
};

describe('invocation handle forwarding', () => {
    describe('exit forms', () => {
        const cases: {
            description: string;
            code: string;
            script: string;
            expectedValue: unknown;
        }[] = [
            {
                description: 'an explicit return of an expression',
                code: 'function f(a) { return a * 2; }',
                script: 'out.result = f(21);',
                expectedValue: 42,
            },
            {
                description: 'a bare return',
                code: 'function f(a) { if (!a) { return; } return a; }',
                script: 'out.result = f(0);',
                expectedValue: undefined,
            },
            {
                description: 'an implicit trailing return',
                code: 'function f(a) { const unused = a; }',
                script: 'out.result = f(1);',
                expectedValue: undefined,
            },
            {
                description: 'a second return in a branch',
                code: 'function f(a) { if (a < 0) { return -1; } return a; }',
                script: 'out.result = f(7);',
                expectedValue: 7,
            },
            {
                description: 'an expression-bodied arrow',
                code: 'const f = (a) => a * 2;',
                script: 'out.result = f(21);',
                expectedValue: 42,
            },
            {
                description: 'a parenthesized arrow body',
                code: 'const f = (a) => ({ v: a });',
                script: 'out.result = f(1);',
                expectedValue: { v: 1 },
            },
            {
                description: 'a sequence-expression arrow body',
                code: 'const f = (a) => (a + 1, a * 2);',
                script: 'out.result = f(21);',
                expectedValue: 42,
            },
        ];

        const throwCase = {
            description: 'the generated catch path',
            code: "function f(a) { throw new Error('boom'); }",
            script: 'try { f(1); } catch (e) { out.result = e.message; }',
            expectedValue: 'boom',
        };

        const allCases = [...cases, throwCase];

        test.each(cases)('should forward the handle through $description', (testCase) => {
            const { runtime, output } = runInstrumented(testCase.code, testCase.script, true);

            expect(runtime.entries).toHaveLength(1);
            expect(runtime.exits).toHaveLength(1);

            const entry = runtime.entries[0];
            const exit = runtime.exits[0];

            expect(exit.kind).toBe('return');
            // The exact object `$dd_entry` returned must reach the exit hook.
            expect(exit.handle).toBe(entry.handle);
            expect(exit.value).toEqual(testCase.expectedValue);
            expect(output.result).toEqual(testCase.expectedValue);
        });

        it('should forward the handle through the generated catch path', () => {
            const { runtime, output } = runInstrumented(throwCase.code, throwCase.script, true);

            expect(runtime.entries).toHaveLength(1);
            expect(runtime.exits).toHaveLength(1);

            const entry = runtime.entries[0];
            const exit = runtime.exits[0];

            expect(exit.kind).toBe('throw');
            expect(exit.handle).toBe(entry.handle);
            // The hook receives the Error itself; the script records its message.
            const thrownText = String(exit.value);
            expect(thrownText).toBe('Error: boom');
            expect(output.result).toBe('boom');
        });

        test.each(allCases)(
            'should skip the exit hooks and preserve the result through $description when no probe produced an entry',
            (testCase) => {
                const { runtime, output } = runInstrumented(testCase.code, testCase.script, false);

                expect(runtime.entries).toHaveLength(0);
                expect(runtime.exits).toHaveLength(0);
                expect(output.result).toEqual(testCase.expectedValue);
            },
        );
    });

    describe('overlapping async invocations', () => {
        // Two calls enter as A then B and settle in the same order, so a LIFO
        // stack would pair each exit with the other invocation's entry.
        const code = `
            async function target(name) {
                const label = name;
                await wait(name);
                return label;
            }
        `;
        const script = `
            out.a = target('A');
            out.b = target('B');
        `;

        const createWaiters = () => {
            const releases: Record<string, () => void> = {};
            const wait = (name: string) =>
                new Promise<void>((resolve) => {
                    releases[name] = resolve;
                });

            return { releases, wait };
        };

        it('should pair each exit with its own entry when calls settle in entry order', async () => {
            const { releases, wait } = createWaiters();
            const { runtime, output } = runInstrumented(code, script, true, { wait });

            expect(runtime.entries).toHaveLength(2);
            expect(runtime.exits).toHaveLength(0);

            releases.A();
            await output.a;
            releases.B();
            await output.b;

            expect(runtime.exits).toHaveLength(2);

            const entryA = runtime.entries[0];
            const entryB = runtime.entries[1];
            expect(entryA.args).toEqual({ name: 'A' });
            expect(entryB.args).toEqual({ name: 'B' });

            const exitA = runtime.exits[0];
            const exitB = runtime.exits[1];
            expect(exitA.value).toBe('A');
            expect(exitA.handle).toBe(entryA.handle);
            expect(exitB.value).toBe('B');
            expect(exitB.handle).toBe(entryB.handle);
        });

        it('should pair each exit with its own entry when calls settle in reverse entry order', async () => {
            const { releases, wait } = createWaiters();
            const { runtime, output } = runInstrumented(code, script, true, { wait });

            expect(runtime.entries).toHaveLength(2);

            releases.B();
            await output.b;
            releases.A();
            await output.a;

            expect(runtime.exits).toHaveLength(2);

            const entryA = runtime.entries[0];
            const entryB = runtime.entries[1];

            const exitB = runtime.exits[0];
            const exitA = runtime.exits[1];
            expect(exitB.value).toBe('B');
            expect(exitB.handle).toBe(entryB.handle);
            expect(exitA.value).toBe('A');
            expect(exitA.handle).toBe(entryA.handle);
        });

        it('should pair a throwing invocation with its own entry while another is in flight', async () => {
            const throwingCode = `
                async function target(name) {
                    await wait(name);
                    if (name === 'B') {
                        throw new Error(name);
                    }
                    return name;
                }
            `;
            const throwingScript = `
                out.a = target('A');
                out.b = target('B').catch((e) => e.message);
            `;
            const { releases, wait } = createWaiters();
            const { runtime, output } = runInstrumented(throwingCode, throwingScript, true, {
                wait,
            });

            expect(runtime.entries).toHaveLength(2);

            releases.A();
            await output.a;
            releases.B();
            await output.b;

            expect(runtime.exits).toHaveLength(2);

            const entryA = runtime.entries[0];
            const entryB = runtime.entries[1];

            const exitA = runtime.exits[0];
            const exitB = runtime.exits[1];
            expect(exitA.kind).toBe('return');
            expect(exitA.handle).toBe(entryA.handle);
            expect(exitB.kind).toBe('throw');
            expect(exitB.handle).toBe(entryB.handle);
        });
    });

    describe('synchronous recursion', () => {
        it('should give each recursive frame its own handle', () => {
            const code = 'function f(n) { if (n === 0) { return 0; } return n + f(n - 1); }';
            const script = 'out.result = f(3);';
            const { runtime, output } = runInstrumented(code, script, true);

            expect(output.result).toBe(6);
            expect(runtime.entries).toHaveLength(4);
            expect(runtime.exits).toHaveLength(4);

            const handleIds = runtime.entries.map((entry) => entry.handle.id);
            const uniqueHandleIds = new Set(handleIds);
            expect(uniqueHandleIds.size).toBe(4);

            // Frames exit innermost-first, so exits mirror the entry order.
            const exitHandles = runtime.exits.map((exit) => exit.handle);
            const reversedEntryHandles = runtime.entries.map((entry) => entry.handle).reverse();
            expect(exitHandles).toEqual(reversedEntryHandles);
        });
    });

    describe('nested functions', () => {
        it('should keep the inner and outer handles distinct', () => {
            const code = 'function outer(a) { const inner = (b) => b + 1; return inner(a); }';
            const script = 'out.result = outer(1);';
            const { runtime, output } = runInstrumented(code, script, true);

            expect(output.result).toBe(2);
            expect(runtime.entries).toHaveLength(2);
            expect(runtime.exits).toHaveLength(2);

            const outerEntry = runtime.entries[0];
            const innerEntry = runtime.entries[1];
            expect(outerEntry.args).toEqual({ a: 1 });
            expect(innerEntry.args).toEqual({ b: 1 });

            const innerExit = runtime.exits[0];
            const outerExit = runtime.exits[1];
            expect(innerExit.handle).toBe(innerEntry.handle);
            expect(outerExit.handle).toBe(outerEntry.handle);
        });
    });
});
