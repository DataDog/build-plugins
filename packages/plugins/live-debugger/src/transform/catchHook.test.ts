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
    exceptionReplay: true,
};

interface CatchCall {
    functionId: string;
    error: unknown;
    self: unknown;
    args: Record<string, unknown> | undefined;
}

interface RunResult {
    catchCalls: CatchCall[];
    throwCalls: unknown[];
    output: Record<string, unknown>;
}

/**
 * Transform `code` and execute it with stubbed Browser Debugger SDK hooks.
 *
 * `hasProbe` controls whether `$dd_probes` returns a probe for every function, and
 * `defineCatchHook: false` leaves `$dd_catch` undefined, as when Exception Replay isn't enabled
 * in the SDK. `script` runs after the transformed code and writes what the test needs onto `out`.
 */
const runInstrumented = (
    code: string,
    script: string,
    {
        hasProbe = false,
        defineCatchHook = true,
        exceptionReplay = true,
    }: { hasProbe?: boolean; defineCatchHook?: boolean; exceptionReplay?: boolean } = {},
): RunResult => {
    const transformed = transformCode({ ...BASE_OPTIONS, exceptionReplay, code });
    const catchCalls: CatchCall[] = [];
    const throwCalls: unknown[] = [];
    const output: Record<string, unknown> = {};
    const sandbox: Record<string, unknown> = {
        out: output,
        $dd_probes: () => (hasProbe ? ['probe'] : undefined),
        $dd_entry: () => ({}),
        $dd_return: (_handle: unknown, value: unknown) => value,
        $dd_throw: (_handle: unknown, error: unknown) => {
            throwCalls.push(error);
        },
    };
    if (defineCatchHook) {
        sandbox.$dd_catch = (
            functionId: string,
            error: unknown,
            self: unknown,
            args?: Record<string, unknown>,
        ) => {
            catchCalls.push({ functionId, error, self, args });
        };
    }

    runInNewContext(`${transformed.code}\n${script}`, sandbox);

    return { catchCalls, throwCalls, output };
};

describe('Exception Replay catch hook', () => {
    it('should report each instrumented frame an exception leaves, innermost first', () => {
        const { catchCalls, output } = runInstrumented(
            [
                'function inner(value) { throw new Error("boom " + value); }',
                'function outer(a, b) { return inner(a + b); }',
            ].join('\n'),
            'try { outer(1, 2); } catch (error) { out.error = error; }',
        );

        expect(catchCalls.map(({ functionId, args }) => ({ functionId, args }))).toEqual([
            { functionId: 'src/utils.ts;inner', args: { value: 3 } },
            { functionId: 'src/utils.ts;outer', args: { a: 1, b: 2 } },
        ]);
        expect(catchCalls[0].error).toBe(output.error);
        expect(catchCalls[1].error).toBe(output.error);
    });

    it('should pass the receiver', () => {
        const { catchCalls, output } = runInstrumented(
            'const obj = { name: "cart", fail() { throw new Error("boom"); } };',
            'try { obj.fail(); } catch { out.obj = obj; }',
        );

        expect(catchCalls).toHaveLength(1);
        expect(catchCalls[0].self).toBe(output.obj);
        expect(catchCalls[0].args).toBeUndefined();
    });

    it('should report the frame when no probe is active', () => {
        const { catchCalls, throwCalls } = runInstrumented(
            'function f() { throw new Error("boom"); }',
            'try { f(); } catch {}',
        );

        expect(catchCalls).toHaveLength(1);
        expect(throwCalls).toHaveLength(0);
    });

    it('should report the frame to both hooks when a probe is active', () => {
        const { catchCalls, throwCalls } = runInstrumented(
            'function f() { throw new Error("boom"); }',
            'try { f(); } catch {}',
            { hasProbe: true },
        );

        expect(catchCalls).toHaveLength(1);
        expect(throwCalls).toHaveLength(1);
        expect(throwCalls[0]).toBe(catchCalls[0].error);
    });

    it('should capture a parameter named e rather than the exception', () => {
        const { catchCalls, throwCalls, output } = runInstrumented(
            'function onClick(e) { throw new Error("boom"); }',
            'try { onClick(42); } catch (error) { out.error = error; }',
            { hasProbe: true },
        );

        expect(catchCalls).toHaveLength(1);
        expect(catchCalls[0].args).toEqual({ e: 42 });
        expect(catchCalls[0].error).toBe(output.error);
        expect(throwCalls[0]).toBe(output.error);
    });

    it('should report rejections of async functions', async () => {
        const { catchCalls, output } = runInstrumented(
            'async function f(id) { await null; throw new Error("boom " + id); }',
            'out.promise = f(7).catch((error) => error);',
        );

        const error = await (output.promise as Promise<unknown>);

        expect(catchCalls).toHaveLength(1);
        expect(catchCalls[0]).toEqual(
            expect.objectContaining({ functionId: 'src/utils.ts;f', error, args: { id: 7 } }),
        );
    });

    it('should rethrow the exception unchanged when the SDK does not define the hook', () => {
        const { catchCalls, output } = runInstrumented(
            'function f() { throw new TypeError("boom"); }',
            'try { f(); } catch (error) { out.error = error; }',
            { defineCatchHook: false },
        );

        expect(catchCalls).toHaveLength(0);
        expect((output.error as Error).message).toBe('boom');
        expect((output.error as Error).name).toBe('TypeError');
    });

    it('should not call the hook when exceptionReplay is disabled', () => {
        const { catchCalls } = runInstrumented(
            'function f() { throw new Error("boom"); }',
            'try { f(); } catch {}',
            { exceptionReplay: false },
        );

        expect(catchCalls).toHaveLength(0);
    });
});
