// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global NodeJS */

import { installFakeProcessEnv } from '@dd/tests/_jest/helpers/env';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SAFE_ENV_KEYS, buildScopedEnv, forceResetEnv, runWithScopedEnv } from './env-guard';

// Hard backstop: process.env is a process-wide singleton, so a test that leaves it swapped (e.g. a bug skipping its own restore) would otherwise leak into every later test in this Jest worker.
afterEach(() => {
    forceResetEnv();
});

// The guard's own realpathSync/readlinkSync checks use references captured once at module load,
// immune to a jest.spyOn() applied afterward — that's the whole point (see env-guard.ts's own
// comment on nativeRealpathSync/nativeReadlinkSync). A test that needs its mock to reach those
// checks has to force a fresh module evaluation, via the same jest.isolateModules() + require()
// pattern already used above, AFTER installing the spy — the shared env/scope state still
// converges on the one real fs-keyed instance, so the top-level imported runWithScopedEnv/
// fs.promises.* continue to work unchanged; only the native captures are freshly re-read.
function reEvaluateEnvGuardWithCurrentMocks(): void {
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./env-guard');
    });
}

describe('env-guard', () => {
    installFakeProcessEnv({
        PATH: '/usr/bin',
        HOME: '/home/dev',
        NODE_ENV: 'test',
        TMPDIR: '/tmp',
    });

    describe('buildScopedEnv', () => {
        // Captured in beforeAll, not as a describe-body constant: a describe body runs at Jest's
        // "collection time", before the outer beforeAll has swapped process.env to the fake
        // baseline, so a plain `const originalEnv = process.env` here would still capture the real,
        // unswapped environment. The Proxy reference itself, not a value-snapshot copy: restoring via
        // a copy is a genuine reassignment (pushed onto the restore history) rather than the
        // self-assignment pop that undoes each test's own swap — a copy would leave every test's
        // push unbalanced.
        let originalEnv: typeof process.env;
        beforeAll(() => {
            originalEnv = process.env;
        });

        afterEach(() => {
            process.env = originalEnv;
        });

        test('Should include only the safe allowlisted keys from the real environment, dropping everything else', () => {
            const safeEntries = SAFE_ENV_KEYS.map((key, index) => [key, `/safe-value-${index}`]);
            const safeValues = Object.fromEntries(safeEntries);
            process.env = {
                ...safeValues,
                AWS_SECRET_ACCESS_KEY: 'super-secret-aws-key',
                DD_API_KEY: 'the-dev-servers-own-api-key',
                SOME_RANDOM_SHELL_VAR: 'whatever',
            };

            const scoped = buildScopedEnv({});

            expect(scoped).toEqual(safeValues);
        });

        test('Should merge in the provided Custom Credentials under their own names', () => {
            process.env = { PATH: '/usr/bin' };

            const scoped = buildScopedEnv({ STRIPE_API_KEY: 'sk_test_123' });

            expect(scoped).toEqual({ PATH: '/usr/bin', STRIPE_API_KEY: 'sk_test_123' });
        });

        test('Should omit an allowlisted key entirely when unset in the real environment, rather than including it as undefined', () => {
            process.env = { PATH: '/usr/bin' };

            const scoped = buildScopedEnv({});

            const unsetSafeKeys = SAFE_ENV_KEYS.filter((key) => key !== 'PATH');
            for (const key of unsetSafeKeys) {
                expect(key in scoped).toBe(false);
            }
        });

        test('Should resolve a SAFE_ENV_KEYS entry under any casing on win32, matching real process.env', () => {
            const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            try {
                process.env = { PATH: 'C:\\Windows' };
                const scoped = buildScopedEnv({});

                expect(scoped.Path).toBe('C:\\Windows');
                expect(scoped.path).toBe('C:\\Windows');
                expect('Path' in scoped).toBe(true);
            } finally {
                if (platformDescriptor) {
                    Object.defineProperty(process, 'platform', platformDescriptor);
                }
            }
        });

        test('Should not resolve a non-allowlisted key under any casing on win32', () => {
            const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            try {
                process.env = { PATH: '/usr/bin' };
                const scoped = buildScopedEnv({ StripeApiKey: 'sk_test_123' });

                expect(scoped.stripeapikey).toBeUndefined();
                expect('stripeapikey' in scoped).toBe(false);
            } finally {
                if (platformDescriptor) {
                    Object.defineProperty(process, 'platform', platformDescriptor);
                }
            }
        });

        // The get/has traps alias any casing to the canonical key, but a write through a
        // non-canonical casing has no trap to resolve against — without one, it creates a separate
        // own property alongside the canonical key instead of updating it, so PATH/Path/path each
        // read back a different, disagreeing value within the same scope.
        test('Should resolve a write to a SAFE_ENV_KEYS entry under any casing to the same canonical key on win32', () => {
            const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            try {
                process.env = { PATH: 'C:\\Windows' };
                const scoped = buildScopedEnv({});

                scoped.Path = 'C:\\NewPath';

                expect(scoped.PATH).toBe('C:\\NewPath');
                expect(scoped.Path).toBe('C:\\NewPath');
                expect(scoped.path).toBe('C:\\NewPath');
            } finally {
                if (platformDescriptor) {
                    Object.defineProperty(process, 'platform', platformDescriptor);
                }
            }
        });
    });

    describe('runWithScopedEnv', () => {
        test('Should expose only the scoped env to fn, not the real process.env', async () => {
            const scoped = { PATH: '/usr/bin', STRIPE_API_KEY: 'sk_test_123' };

            const seenKeys = await runWithScopedEnv(scoped, async () => Object.keys(process.env));

            expect(seenKeys.sort()).toEqual(['PATH', 'STRIPE_API_KEY']);
        });

        test("Should never expose the real DD_API_KEY/DATADOG_API_KEY (the dev server's own credential) to fn", async () => {
            const originalEnv = process.env;
            process.env = { ...originalEnv, DD_API_KEY: 'the-dev-servers-own-api-key' };

            try {
                const seenApiKey = await runWithScopedEnv(
                    { PATH: '/usr/bin' },
                    async () => process.env.DD_API_KEY,
                );
                expect(seenApiKey).toBeUndefined();
            } finally {
                process.env = originalEnv;
            }
        });

        test('Should restore the real process.env after fn resolves', async () => {
            const realEnvSnapshot = { ...process.env };
            await runWithScopedEnv({ PATH: '/usr/bin' }, async () => undefined);
            expect({ ...process.env }).toEqual(realEnvSnapshot);
        });

        test('Should restore the real process.env even when fn throws', async () => {
            const realEnvSnapshot = { ...process.env };
            await expect(
                runWithScopedEnv({ PATH: '/usr/bin' }, async () => {
                    throw new Error('customer function boom');
                }),
            ).rejects.toThrow('customer function boom');
            expect({ ...process.env }).toEqual(realEnvSnapshot);
        });

        // A zombie execution's continuation stays bound to the scope it started with via
        // AsyncLocalStorage, so it can never observe or corrupt a newer, unrelated execution's
        // separate scope — mirrors network-guard.ts's abandon-not-cancel protection for network
        // access. Each scope's view is captured from inside its own callback, not read from the
        // test's outer continuation, since AsyncLocalStorage only propagates into a run() callback,
        // never back out to whatever called runWithScopedEnv without awaiting it.
        test("Should not let an abandoned runWithScopedEnv call's own continuation see a newer, currently-active scoped window", async () => {
            const realEnvSnapshot = { ...process.env };

            let resolveAbandoned: (() => void) | undefined;
            const abandoned = runWithScopedEnv({ PATH: '/abandoned' }, async () => {
                await new Promise<void>((resolve) => {
                    resolveAbandoned = resolve;
                });
                // Resumed after `current` below has already started its own, separate scope —
                // must still see its OWN scope, never the newer one's.
                return process.env.PATH;
            });

            // A second, newer execution starts its own scoped-env window while the abandoned one's
            // continuation is still pending (the timeout handler abandons rather than cancels it).
            // Its view is captured synchronously, before its first await.
            let resolveCurrent: (() => void) | undefined;
            let currentSeenMidFlight: string | undefined;
            const current = runWithScopedEnv({ PATH: '/current' }, async () => {
                currentSeenMidFlight = process.env.PATH;
                await new Promise<void>((resolve) => {
                    resolveCurrent = resolve;
                });
                return process.env.PATH;
            });
            expect(currentSeenMidFlight).toBe('/current');

            resolveAbandoned?.();
            await expect(abandoned).resolves.toBe('/abandoned');

            resolveCurrent?.();
            await expect(current).resolves.toBe('/current');
            expect({ ...process.env }).toEqual(realEnvSnapshot);
        });

        // Regression coverage: a plain `process.env[key] = value` for an existing key, made from
        // outside any scope, passes the Proxy itself as `receiver` — which on an existing writable
        // property falls back to a PARTIAL descriptor that Node's native process.env binding
        // rejects (dd-trace's require-hook hits this exact case). This describe block's fake
        // baseline object tolerates that same partial descriptor where a real, unpatched Node
        // process would throw, so this only asserts the fix's observable contract inside Jest.
        test('Should not throw when assigning an already-existing key on process.env while unscoped', () => {
            const before = process.env.PATH;
            try {
                expect(() => {
                    process.env.PATH = '/already-existing-key-reassigned';
                }).not.toThrow();
                expect(process.env.PATH).toBe('/already-existing-key-reassigned');
            } finally {
                process.env.PATH = before;
            }
        });

        // A brand-new key never existed on the Proxy's own target, so OrdinarySet's
        // CreateDataProperty path (a full descriptor, not a partial one) always succeeds here —
        // kept as a regression guard against this case regressing alongside the partial-descriptor
        // one above.
        test('Should still assign a brand-new key on process.env while unscoped', () => {
            expect(() => {
                process.env.DD_TEST_BRAND_NEW_ENV_GUARD_KEY = 'brand-new-value';
            }).not.toThrow();
            expect(process.env.DD_TEST_BRAND_NEW_ENV_GUARD_KEY).toBe('brand-new-value');
            delete process.env.DD_TEST_BRAND_NEW_ENV_GUARD_KEY;
        });

        // Assignment from inside an active scope resolves against the scoped view only, isolated
        // from the real environment, for both an existing (allowlisted) key and a brand-new one.
        test('Should still assign a key on process.env from inside an active scope, isolated to the real environment', async () => {
            const realEnvSnapshot = { ...process.env };

            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                process.env.PATH = '/scoped-and-reassigned';
                expect(process.env.PATH).toBe('/scoped-and-reassigned');
                process.env.NEW_SCOPED_KEY = 'only-visible-in-scope';
                expect(process.env.NEW_SCOPED_KEY).toBe('only-visible-in-scope');
            });

            expect({ ...process.env }).toEqual(realEnvSnapshot);
        });

        // Other code — a test's own isolation swap, a dotenv-style tool — can and does reassign
        // process.env wholesale after this module first loads; the guard must treat whatever it
        // currently is as the new real fallback rather than silently going stale and unguarded.
        test('Should adopt a wholesale process.env reassignment as the new real fallback, not a stale one', async () => {
            const originalEnv = process.env;
            process.env = { PATH: '/reassigned', SOME_NEW_VAR: 'set-after-reassignment' };

            try {
                const seenPath = await runWithScopedEnv(
                    { PATH: '/scoped' },
                    async () => process.env.PATH,
                );
                expect(seenPath).toBe('/scoped');

                expect(process.env.PATH).toBe('/reassigned');
                expect(process.env.SOME_NEW_VAR).toBe('set-after-reassignment');
            } finally {
                process.env = originalEnv;
            }
        });

        // Without this, a customer function could do `process.env = {...}` from inside its own
        // scope with no error at all — a plain reassignment replaces process's own `env` property
        // outright, bypassing every trap on the object those traps guard. The NEXT runWithScopedEnv
        // call's own install check would then silently adopt the customer's object as the new real
        // fallback, corrupting every later, unrelated execution's safe-allowlisted view.
        test("Should reject a customer function's wholesale process.env reassignment from inside its own scope", async () => {
            const realEnvSnapshot = { ...process.env };

            await expect(
                runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    process.env = { INJECTED: 'attacker-controlled' };
                }),
            ).rejects.toThrow(/[Rr]eassigning process\.env is not allowed/);

            // The blocked attempt must not have corrupted the real fallback a LATER, unrelated
            // execution builds its own scoped view from.
            expect({ ...process.env }).toEqual(realEnvSnapshot);
            const laterScopedPath = await runWithScopedEnv(
                { PATH: '/later' },
                async () => process.env.PATH,
            );
            expect(laterScopedPath).toBe('/later');
        });

        // Regression coverage: a naive fix (unconditionally adopting any reassignment made outside
        // an active scope as the new real fallback) breaks the common "capture process.env, do
        // something, restore it" pattern — capturing process.env captures a reference to the Proxy
        // itself, so restoring it later would recurse into the same trap forever.
        test('Should not infinitely recurse when process.env is captured and reassigned back to itself', () => {
            const captured = process.env;
            process.env = captured;

            expect(() => process.env.PATH).not.toThrow();
        });

        // A single-level self-assignment can't tell a real restore from a no-op that happens to leave
        // realEnv unchanged. Nesting two swaps proves the restore is a genuine pop, not a no-op: the
        // inner self-assignment must bring back the outer swap's value, not the original real env or
        // the value stuck from the inner swap.
        test('Should restore the correct intermediate value when process.env is captured, swapped, and restored twice, nested', () => {
            const originalPath = process.env.PATH;
            const outerCaptured = process.env;
            process.env = { PATH: '/outer-swap' } as NodeJS.ProcessEnv;
            const innerCaptured = process.env;
            process.env = { PATH: '/inner-swap' } as NodeJS.ProcessEnv;

            expect(process.env.PATH).toBe('/inner-swap');
            process.env = innerCaptured;
            expect(process.env.PATH).toBe('/outer-swap');
            process.env = outerCaptured;
            expect(process.env.PATH).toBe(originalPath);
        });

        // Reflect.get throws for a non-object value, and isEnvProxy() is the setter's first check on
        // whatever gets assigned — without its own object/null guard, `process.env = null` (or
        // undefined) would surface as an unhandled native TypeError instead of this file's own clear
        // rejection message.
        test('Should reject reassigning process.env to null or undefined with a clear error, not a native TypeError', () => {
            const originalPath = process.env.PATH;

            expect(() => {
                process.env = null as unknown as NodeJS.ProcessEnv;
            }).toThrow(/process\.env/i);
            expect(() => {
                process.env = undefined as unknown as NodeJS.ProcessEnv;
            }).toThrow(/process\.env/i);

            expect(process.env.PATH).toBe(originalPath);
        });

        // A number or string reassigned to process.env would corrupt realEnv the same way
        // null/undefined does, so the guard covers every non-object primitive, not just the two
        // nullish ones.
        test('Should reject reassigning process.env to a primitive (e.g. a number), not corrupt the real environment', () => {
            const originalPath = process.env.PATH;

            expect(() => {
                process.env = 1 as unknown as NodeJS.ProcessEnv;
            }).toThrow(/process\.env/i);

            expect(process.env.PATH).toBe(originalPath);
        });

        // Regression coverage: this file gets evaluated more than once in practice (Jest's
        // per-test-file module isolation, or a duplicated bundled copy) — two jest.isolateModules()
        // evaluations reproduce that directly. The real secret is set before the first instance
        // ever installs its Proxy, so a later-created instance's runWithScopedEnv call must still
        // hide it, matching network-guard.ts's getSharedContext() reasoning for shared state.
        test('Should correctly scope process.env even when this module is evaluated a second time', async () => {
            const originalEnv = process.env;
            process.env = { CROSS_INSTANCE_SECRET: 'sk_should_never_leak' };

            let firstInstance: typeof import('./env-guard') | undefined;
            let secondInstance: typeof import('./env-guard') | undefined;
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                firstInstance = require('./env-guard') as typeof import('./env-guard');
            });
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                secondInstance = require('./env-guard') as typeof import('./env-guard');
            });
            if (!firstInstance || !secondInstance) {
                throw new Error('jest.isolateModules() did not run its callback synchronously');
            }
            expect(secondInstance.runWithScopedEnv).not.toBe(firstInstance.runWithScopedEnv);

            try {
                const seenSecret = await secondInstance.runWithScopedEnv(
                    { PATH: '/scoped' },
                    async () => process.env.CROSS_INSTANCE_SECRET,
                );
                expect(seenSecret).toBeUndefined();
            } finally {
                process.env = originalEnv;
            }
        });

        // Without a setPrototypeOf trap, this call defaults to mutating `target` — the real,
        // unscoped env object — even when called from inside a scope, letting a customer function
        // poison the real environment's prototype chain permanently, outliving its own scope.
        test('Should confine Object.setPrototypeOf(process.env, ...) to the scoped view, never the real env', async () => {
            const realProtoBefore = Object.getPrototypeOf(process.env);
            const poisonedProto = { POISONED: 'yes' };

            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                Object.setPrototypeOf(process.env, poisonedProto);
                return undefined;
            });

            expect(Object.getPrototypeOf(process.env)).toBe(realProtoBefore);
        });

        // Without a getPrototypeOf trap, this always defaults to reading `target` (the real env's
        // untouched prototype) even inside a scope — so a customer function that just successfully
        // scoped-set a prototype via setPrototypeOf would immediately read back the wrong value.
        test('Should read back the same prototype just set via Object.setPrototypeOf(process.env, ...) within the same scope', async () => {
            const scopedProto = { SCOPED: 'yes' };

            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                Object.setPrototypeOf(process.env, scopedProto);
                expect(Object.getPrototypeOf(process.env)).toBe(scopedProto);
            });
        });

        // Without a preventExtensions trap, this call defaults to forwarding to `target` — the real
        // env object — permanently making it non-extensible. Every later unscoped
        // ownKeys/getOwnPropertyDescriptor call then throws, since the Proxy's ownKeys trap (which
        // resolves through currentEnv(), not the now-frozen target) returns a key set the engine can
        // no longer reconcile with a non-extensible target — bricking process.env for the rest of the
        // dev server process.
        test('Should reject Object.freeze/Object.preventExtensions(process.env) without bricking it', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => Object.freeze(process.env)).toThrow();
                return undefined;
            });

            expect(Object.isExtensible(process.env)).toBe(true);
            process.env.POST_ATTEMPT_KEY = 'still-writable';
            expect(process.env.POST_ATTEMPT_KEY).toBe('still-writable');
            delete process.env.POST_ATTEMPT_KEY;
        });

        // A non-configurable definition can never satisfy the Proxy invariant against
        // INERT_PROXY_TARGET (always empty), so it must throw a clear, guard-specific error rather
        // than a cryptic native Proxy TypeError — even outside any scope, since the target is
        // permanently empty regardless of scope state.
        test('Should throw a clear error for Object.defineProperty(process.env, key, { configurable: false })', () => {
            expect(() =>
                Object.defineProperty(process.env, 'LOCKED_KEY', {
                    value: 'x',
                    configurable: false,
                }),
            ).toThrow(/non-configurable/);
        });
    });

    // Regression coverage for the /proc/.../environ backing-store bypass: swapping process.env alone doesn't stop reads of the kernel-backed environ file directly on Linux.
    describe('environ-file guard', () => {
        // fs.readFile/open/copyFile/cp report failure via their own error-first callback, never a
        // synchronous throw — resolves with whatever the callback is eventually invoked with, so a
        // caller can assert on it the same way as the promise-returning equivalents below.
        function callbackError(
            invoke: (callback: (error: unknown) => void) => void,
        ): Promise<unknown> {
            return new Promise((resolve) => {
                invoke((error) => resolve(error));
            });
        }

        test('Should block fs.readFileSync("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.readFileSync('/proc/self/environ')).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        test(`Should block fs.readFileSync("/proc/${process.pid}/environ") during an active scoped-env window`, async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.readFileSync(`/proc/${process.pid}/environ`)).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        test('Should block fs.promises.readFile("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                await expect(fs.promises.readFile('/proc/self/environ')).rejects.toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        // fs.promises.readFile also accepts an already-open FileHandle in place of a path, caught
        // the same way as a plain fd. Linux-only: opening a real FileHandle against
        // /proc/self/environ needs /proc to exist at all.
        test('Should block fs.promises.readFile(handle) when handle is a FileHandle already open against /proc/self/environ', async () => {
            if (process.platform !== 'linux') {
                return;
            }

            const handle = await fs.promises.open('/proc/self/environ', 'r');
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    await expect(fs.promises.readFile(handle)).rejects.toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                await handle.close();
            }
        });

        // Mocks process.platform and fs.readlinkSync so the FileHandle-resolution path is verified
        // on every OS this suite runs on, not just Linux CI. A FileHandle isn't a plain number, so
        // this passes a minimal duck-typed stand-in exposing only the `.fd` property the guard reads.
        test('Should block fs.promises.readFile(handle) when handle.fd resolves to /proc/self/environ, on any OS', async () => {
            const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
            const readlinkSyncSpy = jest
                .spyOn(fs, 'readlinkSync')
                .mockImplementation((linkPath) => {
                    expect(linkPath).toBe('/proc/self/fd/99');
                    return '/proc/self/environ';
                });
            reEvaluateEnvGuardWithCurrentMocks();
            const fakeHandle = { fd: 99 } as unknown as Parameters<typeof fs.promises.readFile>[0];

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    await expect(fs.promises.readFile(fakeHandle)).rejects.toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                readlinkSyncSpy.mockRestore();
                if (platformDescriptor) {
                    Object.defineProperty(process, 'platform', platformDescriptor);
                }
            }
        });

        // Mirrors the FileHandle.prototype.read guard's own shadow test: extractFdNumber's naive
        // `.fd` read used to trust an own property shadowing the handle's real, dangerous target
        // with a harmless-looking value — letting fs.promises.readFile(handle) leak the real
        // /proc/self/environ contents Node's own implementation reads via the handle's true fd.
        test("Should block fs.promises.readFile(handle) when the handle's own fd is shadowed to a different, harmless value, even though its real target is /proc/self/environ", async () => {
            if (process.platform !== 'linux') {
                return;
            }

            const dangerousHandle = await fs.promises.open('/proc/self/environ', 'r');
            const tmpFile = path.join(
                os.tmpdir(),
                `env-guard-readfile-fd-shadow-${process.pid}.txt`,
            );
            fs.writeFileSync(tmpFile, 'not a secret');
            const harmlessHandle = await fs.promises.open(tmpFile, 'r');
            try {
                Object.defineProperty(dangerousHandle, 'fd', {
                    value: harmlessHandle.fd,
                    configurable: true,
                });
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    await expect(fs.promises.readFile(dangerousHandle)).rejects.toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                delete (dangerousHandle as unknown as Record<string, unknown>).fd;
                await dangerousHandle.close();
                await harmlessHandle.close();
                fs.rmSync(tmpFile, { force: true });
            }
        });

        test('Should not block fs.promises.readFile(handle) for an unrelated real file during an active scoped-env window', async () => {
            const tmpFile = path.join(
                os.tmpdir(),
                `env-guard-readfile-handle-ok-${process.pid}.txt`,
            );
            fs.writeFileSync(tmpFile, 'hello world');
            const handle = await fs.promises.open(tmpFile, 'r');
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    await expect(fs.promises.readFile(handle, 'utf8')).resolves.toBe('hello world');
                });
            } finally {
                await handle.close();
                fs.rmSync(tmpFile, { force: true });
            }
        });

        // Regression coverage: the callback-style fs.readFile must report failure via its own
        // callback, not a synchronous throw — a caller relying on the real error-first-callback
        // contract (with no surrounding try/catch, which that contract never requires) would
        // otherwise crash instead of seeing the error.
        test('Should block the callback-style fs.readFile("/proc/self/environ") via its callback, not a synchronous throw, during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                let errorPromise: Promise<unknown> | undefined;
                expect(() => {
                    errorPromise = callbackError((callback) =>
                        fs.readFile('/proc/self/environ', callback),
                    );
                }).not.toThrow();
                const error = await errorPromise;
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toMatch(/not allowed in backend functions/);
            });
        });

        test('Should block fs.createReadStream("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.createReadStream('/proc/self/environ')).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        // fs.createReadStream(path, { fd }) makes Node read from the fd directly, ignoring `path`
        // entirely — the guard must inspect options.fd too, not just the (here, deliberately
        // unrelated) leading path argument. Linux-only: opening a real fd against
        // /proc/self/environ needs /proc to exist at all.
        test('Should block fs.createReadStream(unrelatedPath, { fd }) when fd is already open against /proc/self/environ', async () => {
            if (process.platform !== 'linux') {
                return;
            }

            const fd = fs.openSync('/proc/self/environ', 'r');
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.createReadStream('/some/unrelated/path', { fd })).toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                fs.closeSync(fd);
            }
        });

        test('Should block new fs.ReadStream(unrelatedPath, { fd }) when fd is already open against /proc/self/environ', async () => {
            if (process.platform !== 'linux') {
                return;
            }

            const fd = fs.openSync('/proc/self/environ', 'r');
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() =>
                        Reflect.construct(fs.ReadStream, ['/some/unrelated/path', { fd }]),
                    ).toThrow(/not allowed in backend functions/);
                });
            } finally {
                fs.closeSync(fd);
            }
        });

        // Mocks process.platform and fs.readlinkSync so the fd-option resolution path itself is
        // verified on every OS this suite runs on, not just in Linux CI (mirroring the equivalent
        // mocked test for the plain numeric-fd case above).
        test('Should block fs.createReadStream(unrelatedPath, { fd }) when fd resolves to /proc/self/environ, on any OS', async () => {
            const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
            const readlinkSyncSpy = jest
                .spyOn(fs, 'readlinkSync')
                .mockImplementation((linkPath) => {
                    expect(linkPath).toBe('/proc/self/fd/99');
                    return '/proc/self/environ';
                });
            reEvaluateEnvGuardWithCurrentMocks();

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.createReadStream('/some/unrelated/path', { fd: 99 })).toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                readlinkSyncSpy.mockRestore();
                if (platformDescriptor) {
                    Object.defineProperty(process, 'platform', platformDescriptor);
                }
            }
        });

        test('Should not block fs.createReadStream(unrelatedPath, { fd }) when fd points at an unrelated real file', async () => {
            const tmpFile = path.join(os.tmpdir(), `env-guard-fd-option-${process.pid}.txt`);
            fs.writeFileSync(tmpFile, 'not a secret');
            const fd = fs.openSync(tmpFile, 'r');
            let stream: fs.ReadStream | undefined;
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => {
                        stream = fs.createReadStream('/some/unrelated/path', { fd });
                        stream.on('error', () => {});
                    }).not.toThrow();
                });
            } finally {
                stream?.destroy();
                fs.rmSync(tmpFile, { force: true });
            }
        });

        // options.fd can itself be a FileHandle rather than a plain number — mirrors the
        // fs.promises.readFile(handle) shadow regression above, for createReadStream's own
        // extractFdNumber call site.
        test("Should block fs.createReadStream(unrelatedPath, { fd: handle }) when the handle's own fd is shadowed to a different, harmless value, even though its real target is /proc/self/environ", async () => {
            if (process.platform !== 'linux') {
                return;
            }

            const dangerousHandle = await fs.promises.open('/proc/self/environ', 'r');
            const tmpFile = path.join(
                os.tmpdir(),
                `env-guard-createreadstream-fd-shadow-${process.pid}.txt`,
            );
            fs.writeFileSync(tmpFile, 'not a secret');
            const harmlessHandle = await fs.promises.open(tmpFile, 'r');
            try {
                Object.defineProperty(dangerousHandle, 'fd', {
                    value: harmlessHandle.fd,
                    configurable: true,
                });
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() =>
                        fs.createReadStream('/some/unrelated/path', { fd: dangerousHandle }),
                    ).toThrow(/not allowed in backend functions/);
                });
            } finally {
                delete (dangerousHandle as unknown as Record<string, unknown>).fd;
                await dangerousHandle.close();
                await harmlessHandle.close();
                fs.rmSync(tmpFile, { force: true });
            }
        });

        // options.fd can be an accessor property whose getter returns a different value on each
        // read — a getter could show the guard's check a safe fd and hand the real implementation's
        // separate read the secret one, so the guard must resolve options.fd exactly once and reuse
        // that value for the real call too. Asserted by content, since the correct behavior is that
        // the read proceeds safely rather than throws.
        test("Should make the real read use only the fd value the guard's own check saw, never a getter's later, different return value", async () => {
            const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
            const safeFile = path.join(os.tmpdir(), `env-guard-fd-toctou-safe-${process.pid}.txt`);
            const secretFile = path.join(
                os.tmpdir(),
                `env-guard-fd-toctou-secret-${process.pid}.txt`,
            );
            fs.writeFileSync(safeFile, 'safe-content');
            fs.writeFileSync(secretFile, 'SECRET-CONTENT');
            const safeFd = fs.openSync(safeFile, 'r');
            const secretFd = fs.openSync(secretFile, 'r');
            const readlinkSyncSpy = jest
                .spyOn(fs, 'readlinkSync')
                .mockImplementation((linkPath) => {
                    if (linkPath === `/proc/self/fd/${secretFd}`) {
                        return '/proc/self/environ';
                    }
                    return '/some/unrelated/real/file';
                });

            let readCount = 0;
            const options = {
                get fd() {
                    readCount += 1;
                    // First read (the guard's own check) sees the safe fd; every later read (what
                    // the real implementation would use if it read this property independently)
                    // would see the secret one instead.
                    return readCount === 1 ? safeFd : secretFd;
                },
            };

            let stream: fs.ReadStream | undefined;
            let streamData = '';
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    stream = fs.createReadStream('/some/unrelated/path', options);
                    await new Promise<void>((resolve, reject) => {
                        stream?.on('data', (chunk) => {
                            streamData += chunk;
                        });
                        stream?.on('end', resolve);
                        stream?.on('error', reject);
                    });
                });

                expect(streamData).toBe('safe-content');
            } finally {
                stream?.destroy();
                readlinkSyncSpy.mockRestore();
                if (platformDescriptor) {
                    Object.defineProperty(process, 'platform', platformDescriptor);
                }
                fs.closeSync(secretFd);
                fs.rmSync(safeFile, { force: true });
                fs.rmSync(secretFile, { force: true });
            }
        });

        test('Should block fs.openSync("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.openSync('/proc/self/environ', 'r')).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        // Regression coverage: same callback-contract requirement as fs.readFile above.
        test('Should block the callback-style fs.open("/proc/self/environ") via its callback, not a synchronous throw, during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                let errorPromise: Promise<unknown> | undefined;
                expect(() => {
                    errorPromise = callbackError((callback) =>
                        fs.open('/proc/self/environ', 'r', callback),
                    );
                }).not.toThrow();
                const error = await errorPromise;
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toMatch(/not allowed in backend functions/);
            });
        });

        test('Should block fs.promises.open("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                await expect(fs.promises.open('/proc/self/environ', 'r')).rejects.toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        // fs.openAsBlob is its own entry point, separate from open*/readFile* above, so it needs its
        // own guard coverage.
        describe('fs.openAsBlob guard', () => {
            test('Should block fs.openAsBlob("/proc/self/environ") during an active scoped-env window', async () => {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    await expect(fs.openAsBlob('/proc/self/environ')).rejects.toThrow(
                        /not allowed in backend functions/,
                    );
                });
            });

            test('Should not block fs.openAsBlob for an unrelated real file during an active scoped-env window', async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-openasblob-ok-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'hello world');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        const blob = await fs.openAsBlob(tmpFile);
                        await expect(blob.text()).resolves.toBe('hello world');
                    });
                } finally {
                    fs.rmSync(tmpFile, { force: true });
                }
            });

            // Deleting fs.openAsBlob and re-evaluating the module simulates Node 18, which has no
            // fs.openAsBlob, matching the feature-detection in packages/core/src/helpers/fs.ts's
            // getFile().
            test('Should leave fs.openAsBlob undefined, not replace it with a broken wrapper, when the real function is absent', () => {
                const originalOpenAsBlob = fs.openAsBlob;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                delete (fs as any).openAsBlob;
                try {
                    expect(() => {
                        jest.isolateModules(() => {
                            // eslint-disable-next-line @typescript-eslint/no-require-imports
                            require('./env-guard');
                        });
                    }).not.toThrow();
                    expect(fs.openAsBlob).toBeUndefined();
                } finally {
                    fs.openAsBlob = originalOpenAsBlob;
                }
            });
        });

        test('Should block a Buffer or URL path pointing at /proc/self/environ, not just a string path', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                const environPathAsBuffer = Buffer.from('/proc/self/environ');
                expect(() => fs.readFileSync(environPathAsBuffer)).toThrow(
                    /not allowed in backend functions/,
                );
                const environPathAsUrl = new URL('file:///proc/self/environ');
                expect(() => fs.readFileSync(environPathAsUrl)).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        test('Should block a Buffer path even when its own toString is overridden to report a benign path', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                const environPathAsBuffer = Buffer.from('/proc/self/environ');
                environPathAsBuffer.toString = () => '/tmp/benign-path';
                expect(() => fs.readFileSync(environPathAsBuffer)).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        test('Should block an unnormalized path like /proc/self/../self/environ, which resolves to the same file', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.readFileSync('/proc/self/../self/environ')).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        test('Should block /proc/thread-self/environ, not just /proc/self and /proc/<pid>', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.readFileSync('/proc/thread-self/environ')).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        // ENVIRON_PATH_RE matches any numeric pid, not just self/thread-self — a readable parent
        // /proc entry (commonly the shell or package manager that launched the dev server, which
        // inherits the same secrets) is just as exploitable as the dev server's own pid.
        test("Should block /proc/<parentPid>/environ, not just the dev server's own pid", async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.readFileSync(`/proc/${process.ppid}/environ`)).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        // A symlink pointing at /proc/self/environ has its own, unrelated literal path, so
        // isEnvironPath() must resolve via realpathSync before matching the regex, since
        // fs.readFileSync and friends follow symlinks transparently. Linux-only: /proc doesn't
        // exist on macOS to reproduce this against.
        test('Should block reading /proc/self/environ through a symlink, not just the literal path', async () => {
            if (process.platform !== 'linux') {
                return;
            }

            const linkPath = path.join(os.tmpdir(), `env-guard-symlink-${process.pid}`);
            fs.symlinkSync('/proc/self/environ', linkPath);

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.readFileSync(linkPath)).toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                fs.unlinkSync(linkPath);
            }
        });

        // A numeric fd already open against /proc/self/environ is just as valid a first argument to
        // fs.readFileSync as a path string — opened here, outside any scope, matching a legitimate
        // fd a customer function could plausibly be handed some other way. Linux-only: resolving a
        // fd back to a path at all relies on /proc/self/fd/<fd>, which only exists on Linux.
        test('Should block reading a numeric fd already open against /proc/self/environ', async () => {
            if (process.platform !== 'linux') {
                return;
            }

            const fd = fs.openSync('/proc/self/environ', 'r');
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.readFileSync(fd)).toThrow(/not allowed in backend functions/);
                });
            } finally {
                fs.closeSync(fd);
            }
        });

        // The test above only exercises real behavior on Linux (it early-returns everywhere else,
        // since /proc/self/fd doesn't exist off Linux); this one mocks process.platform and
        // fs.readlinkSync so the numeric-fd resolution path itself is verified on every OS this
        // suite runs on, not just in Linux CI.
        test('Should resolve a numeric fd to its environ target via a mocked /proc/self/fd readlink, on any OS', async () => {
            const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
            const readlinkSyncSpy = jest
                .spyOn(fs, 'readlinkSync')
                .mockImplementation((linkPath) => {
                    expect(linkPath).toBe('/proc/self/fd/99');
                    return '/proc/self/environ';
                });
            reEvaluateEnvGuardWithCurrentMocks();

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.readFileSync(99)).toThrow(/not allowed in backend functions/);
                });
            } finally {
                readlinkSyncSpy.mockRestore();
                if (platformDescriptor) {
                    Object.defineProperty(process, 'platform', platformDescriptor);
                }
            }
        });

        // Regression coverage for a same-call bypass: replacing fs.realpathSync/readlinkSync from
        // inside a scope must not defeat a read that same call makes — the guard has to keep using
        // the reference captured at module load, not the live, tampered fs methods.
        test('Should keep blocking a forged path even when a backend function replaces fs.realpathSync/readlinkSync from inside its own scope', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                const realpathSyncSpy = jest
                    .spyOn(fs, 'realpathSync')
                    .mockReturnValue(
                        '/some/benign/path' as unknown as ReturnType<typeof fs.realpathSync>,
                    );
                const readlinkSyncSpy = jest
                    .spyOn(fs, 'readlinkSync')
                    .mockReturnValue(
                        '/some/benign/path' as unknown as ReturnType<typeof fs.readlinkSync>,
                    );
                try {
                    expect(() => fs.readFileSync('/proc/self/environ')).toThrow(
                        /not allowed in backend functions/,
                    );
                } finally {
                    realpathSyncSpy.mockRestore();
                    readlinkSyncSpy.mockRestore();
                }
            });
        });

        test('Should not block reading /proc/self/environ once the scoped-env window has closed', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => undefined);

            // Off Linux, /proc doesn't exist; the assertion is only that our guard doesn't fire once idle, not that the read succeeds.
            expect(() => fs.readFileSync('/proc/self/environ')).not.toThrow(
                /not allowed in backend functions/,
            );
        });

        // realpathSync can fail for reasons other than "path doesn't exist yet" (EACCES, ELOOP, ...).
        // Treating every failure the same as ENOENT and falling back to the unresolved literal path
        // would never match ENVIRON_PATH_RE for a symlink, silently letting a real /proc/.../environ
        // read through. Must deny the read either way, but by re-throwing the real error rather than
        // a misleading "environ" message — the real fs call would hit the identical error anyway, so
        // this only fixes what the customer sees, not whether the read is denied.
        test('Should re-throw the real error (not a misleading "environ" message) when realpathSync fails for a reason other than ENOENT', async () => {
            const realpathSyncSpy = jest.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
                const error: NodeJS.ErrnoException = new Error('permission denied');
                error.code = 'EACCES';
                throw error;
            });
            reEvaluateEnvGuardWithCurrentMocks();

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.readFileSync('/some/unrelated/path')).toThrow(
                        'permission denied',
                    );
                });
            } finally {
                realpathSyncSpy.mockRestore();
            }
        });

        // fs.promises.* must reject, never throw synchronously, on any failure including this one —
        // a caller doing `fs.promises.readFile(x).catch(handler)` with no enclosing try/catch would
        // otherwise crash the process instead of reaching its own error handling.
        test('Should reject (not throw synchronously) when realpathSync fails for a reason other than ENOENT during an fs.promises.* call', async () => {
            const realpathSyncSpy = jest.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
                const error: NodeJS.ErrnoException = new Error('permission denied');
                error.code = 'EACCES';
                throw error;
            });
            reEvaluateEnvGuardWithCurrentMocks();

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    await expect(fs.promises.readFile('/some/unrelated/path')).rejects.toThrow(
                        'permission denied',
                    );
                });
            } finally {
                realpathSyncSpy.mockRestore();
            }
        });

        test('Should not block reading an unrelated real file during an active scoped-env window', async () => {
            const tmpFile = path.join(os.tmpdir(), `env-guard-test-${process.pid}.txt`);
            fs.writeFileSync(tmpFile, 'not a secret');

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(fs.readFileSync(tmpFile, 'utf8')).toBe('not a secret');
                    await expect(fs.promises.readFile(tmpFile, 'utf8')).resolves.toBe(
                        'not a secret',
                    );
                    const [data, error] = await new Promise<[string | undefined, unknown]>(
                        (resolve) => {
                            fs.readFile(tmpFile, 'utf8', (err, contents) =>
                                resolve([contents, err]),
                            );
                        },
                    );
                    expect(error).toBeNull();
                    expect(data).toBe('not a secret');
                });
            } finally {
                fs.rmSync(tmpFile);
            }
        });

        // copyFileSync/copyFile/promises.copyFile/cpSync/promises.cp copy the source file's bytes
        // via a native binding that bypasses readFile*/open* entirely, so they need their own,
        // separately-verified coverage rather than relying on the read-family guard above.
        test('Should block fs.copyFileSync("/proc/self/environ") during an active scoped-env window', async () => {
            const dest = path.join(os.tmpdir(), `env-guard-copy-${process.pid}.txt`);
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.copyFileSync('/proc/self/environ', dest)).toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                fs.rmSync(dest, { force: true });
            }
        });

        // Regression coverage: same callback-contract requirement as fs.readFile above.
        test('Should block the callback-style fs.copyFile("/proc/self/environ") via its callback, not a synchronous throw, during an active scoped-env window', async () => {
            const dest = path.join(os.tmpdir(), `env-guard-copy-cb-${process.pid}.txt`);
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    let errorPromise: Promise<unknown> | undefined;
                    expect(() => {
                        errorPromise = callbackError((callback) =>
                            fs.copyFile('/proc/self/environ', dest, callback),
                        );
                    }).not.toThrow();
                    const error = await errorPromise;
                    expect(error).toBeInstanceOf(Error);
                    expect((error as Error).message).toMatch(/not allowed in backend functions/);
                });
            } finally {
                fs.rmSync(dest, { force: true });
            }
        });

        test('Should block fs.promises.copyFile("/proc/self/environ") during an active scoped-env window', async () => {
            const dest = path.join(os.tmpdir(), `env-guard-copy-async-${process.pid}.txt`);
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    await expect(fs.promises.copyFile('/proc/self/environ', dest)).rejects.toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                fs.rmSync(dest, { force: true });
            }
        });

        test('Should block fs.cpSync/fs.promises.cp("/proc/self/environ") during an active scoped-env window', async () => {
            const destSync = path.join(os.tmpdir(), `env-guard-cp-sync-${process.pid}.txt`);
            const destAsync = path.join(os.tmpdir(), `env-guard-cp-async-${process.pid}.txt`);
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.cpSync('/proc/self/environ', destSync)).toThrow(
                        /not allowed in backend functions/,
                    );
                    await expect(fs.promises.cp('/proc/self/environ', destAsync)).rejects.toThrow(
                        /not allowed in backend functions/,
                    );
                });
            } finally {
                fs.rmSync(destSync, { force: true });
                fs.rmSync(destAsync, { force: true });
            }
        });

        // Regression coverage: same callback-contract requirement as fs.readFile above.
        test('Should block the callback-style fs.cp("/proc/self/environ") via its callback, not a synchronous throw, during an active scoped-env window', async () => {
            const dest = path.join(os.tmpdir(), `env-guard-cp-cb-${process.pid}.txt`);
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    let errorPromise: Promise<unknown> | undefined;
                    expect(() => {
                        errorPromise = callbackError((callback) =>
                            fs.cp('/proc/self/environ', dest, callback),
                        );
                    }).not.toThrow();
                    const error = await errorPromise;
                    expect(error).toBeInstanceOf(Error);
                    expect((error as Error).message).toMatch(/not allowed in backend functions/);
                });
            } finally {
                fs.rmSync(dest, { force: true });
            }
        });

        // A malformed fs.cp call throws synchronously from Node's own argument validation, not from
        // the guard, so it must propagate unguarded like every other entry point here.
        test('Should let a malformed fs.cp call (no callback) throw synchronously, not swallow the error', () => {
            expect(() => {
                (fs.cp as unknown as (src: string, dest: string) => void)('/tmp', '/tmp/x');
            }).toThrow(/must be of type function/i);
        });

        // new fs.ReadStream(path) constructs directly, bypassing the createReadStream factory the
        // guard above wraps, so it needs separate coverage. @types/node declares no (path, options)
        // constructor for ReadStream, so Reflect.construct invokes the real, untyped signature
        // directly. The unrelated-file case attaches a no-op error listener: the underlying async
        // open can still be in flight when the test's finally block deletes the file, which would
        // otherwise surface as an unhandled 'error' event.
        function constructReadStream(rawPath: string): fs.ReadStream {
            const stream: fs.ReadStream = Reflect.construct(fs.ReadStream, [rawPath]);
            stream.on('error', () => {});
            return stream;
        }

        test('Should block constructing new fs.ReadStream("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => constructReadStream('/proc/self/environ')).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        test('Should not block constructing new fs.ReadStream(...) for an unrelated real file during an active scoped-env window', async () => {
            const tmpFile = path.join(os.tmpdir(), `env-guard-readstream-${process.pid}.txt`);
            fs.writeFileSync(tmpFile, 'not a secret');
            let stream: fs.ReadStream | undefined;

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => {
                        stream = constructReadStream(tmpFile);
                    }).not.toThrow();
                });
            } finally {
                stream?.destroy();
                fs.rmSync(tmpFile);
            }
        });

        // fs.FileReadStream is a real, long-deprecated alias for fs.ReadStream — a separate property
        // slot that must be re-pointed at the same wrapped class, or constructing through this name
        // bypasses the guard above entirely.
        describe('fs.FileReadStream alias guard', () => {
            function constructFileReadStream(rawPath: string): fs.ReadStream {
                const stream: fs.ReadStream = Reflect.construct(fs.FileReadStream, [rawPath]);
                stream.on('error', () => {});
                return stream;
            }

            test('Should block constructing new fs.FileReadStream("/proc/self/environ") during an active scoped-env window', async () => {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => constructFileReadStream('/proc/self/environ')).toThrow(
                        /not allowed in backend functions/,
                    );
                });
            });

            test('Should not block constructing new fs.FileReadStream(...) for an unrelated real file during an active scoped-env window', async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filereadstream-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'not a secret');
                let stream: fs.ReadStream | undefined;

                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => {
                            stream = constructFileReadStream(tmpFile);
                        }).not.toThrow();
                    });
                } finally {
                    stream?.destroy();
                    fs.rmSync(tmpFile);
                }
            });
        });

        // fs.read/readSync/readv/readvSync take an fd directly, the same case toPathString()'s
        // /proc/self/fd resolution already covers elsewhere — mocked here so that resolution runs
        // on every OS, not just Linux.
        describe('fd-based read guard (fs.read/readSync/readv/readvSync)', () => {
            function mockFdResolvesToEnviron(fd: number): () => void {
                const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
                Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
                const readlinkSyncSpy = jest
                    .spyOn(fs, 'readlinkSync')
                    .mockImplementation((linkPath) => {
                        expect(linkPath).toBe(`/proc/self/fd/${fd}`);
                        return '/proc/self/environ';
                    });
                reEvaluateEnvGuardWithCurrentMocks();
                return () => {
                    readlinkSyncSpy.mockRestore();
                    if (platformDescriptor) {
                        Object.defineProperty(process, 'platform', platformDescriptor);
                    }
                };
            }

            test('Should block fs.readSync(fd) when fd resolves to /proc/self/environ', async () => {
                const restore = mockFdResolvesToEnviron(99);
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => fs.readSync(99, Buffer.alloc(10), 0, 10, 0)).toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    restore();
                }
            });

            test('Should block the callback-style fs.read(fd) via its callback, not a synchronous throw, when fd resolves to /proc/self/environ', async () => {
                const restore = mockFdResolvesToEnviron(99);
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        const error = await callbackError((callback) =>
                            fs.read(99, Buffer.alloc(10), 0, 10, 0, callback),
                        );
                        expect(error).toBeInstanceOf(Error);
                        expect((error as Error).message).toMatch(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    restore();
                }
            });

            test('Should block fs.readvSync(fd) when fd resolves to /proc/self/environ', async () => {
                const restore = mockFdResolvesToEnviron(99);
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => fs.readvSync(99, [Buffer.alloc(10)])).toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    restore();
                }
            });

            test('Should block the callback-style fs.readv(fd) via its callback, not a synchronous throw, when fd resolves to /proc/self/environ', async () => {
                const restore = mockFdResolvesToEnviron(99);
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        const error = await callbackError((callback) =>
                            fs.readv(99, [Buffer.alloc(10)], callback),
                        );
                        expect(error).toBeInstanceOf(Error);
                        expect((error as Error).message).toMatch(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    restore();
                }
            });

            test('Should not block fs.readSync/readvSync for an unrelated real fd during an active scoped-env window', async () => {
                const tmpFile = path.join(os.tmpdir(), `env-guard-read-fd-${process.pid}.txt`);
                fs.writeFileSync(tmpFile, 'hello world');
                const fd = fs.openSync(tmpFile, 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        const buffer = Buffer.alloc(5);
                        expect(fs.readSync(fd, buffer, 0, 5, 0)).toBe(5);
                        expect(buffer.toString('utf8')).toBe('hello');
                    });
                } finally {
                    fs.closeSync(fd);
                    fs.rmSync(tmpFile, { force: true });
                }
            });
        });

        // FileHandle isn't part of Node's public API, so ensureFileHandleReadGuarded patches its
        // .read() lazily, per-instance, once a handle is already open.
        describe('FileHandle.prototype.read guard', () => {
            test('Should block handle.read() when the handle is already open against /proc/self/environ', async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const handle = await fs.promises.open('/proc/self/environ', 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        await expect(handle.read(Buffer.alloc(10), 0, 10, 0)).rejects.toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    await handle.close();
                }
            });

            // No mocked any-OS variant here — mutating process.platform around a real, async
            // handle.read() I/O call raced other test files sharing the process, unlike the
            // synchronous reads elsewhere in this file.
            test('Should not block handle.read() for an unrelated real file during an active scoped-env window', async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filehandle-ok-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'hello world');
                const handle = await fs.promises.open(tmpFile, 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        const buffer = Buffer.alloc(5);
                        const { bytesRead } = await handle.read(buffer, 0, 5, 0);
                        expect(bytesRead).toBe(5);
                        expect(buffer.toString('utf8', 0, 5)).toBe('hello');
                    });
                } finally {
                    await handle.close();
                    fs.rmSync(tmpFile, { force: true });
                }
            });

            // Verifies the guard resolves the handle's real fd via a captured native getter, not an
            // own-property shadow — independent of Node's own read() dispatch, which could itself be
            // fooled by the same shadow on some versions. Real /proc/self/environ, not a mocked
            // readlink: the guard's own fs.realpathSync/readlinkSync are captured once at module load
            // (see nativeRealpathSync/nativeReadlinkSync), so a jest.spyOn() applied after this file's
            // first import can't reach them — this only exercises real behavior on Linux.
            test("Should block handle.read() using the handle's real fd, even when an own property shadows it with a harmless value", async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const handle = await fs.promises.open('/proc/self/environ', 'r');
                const realFd = handle.fd;
                try {
                    // A harmless-looking own property, distinct from realFd, simulating a
                    // customer-controlled wrapper lying about which fd this handle was opened against.
                    Object.defineProperty(handle, 'fd', { value: 999999, configurable: true });
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        await expect(handle.read(Buffer.alloc(10), 0, 10, 0)).rejects.toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    Object.defineProperty(handle, 'fd', { value: realFd, configurable: true });
                    await handle.close();
                }
            });

            // The inverse of the shadow test above: the handle's real target is harmless, but an own
            // property shadows .fd with a different, dangerous fd number. The guard's own check (via
            // the captured native getter) correctly sees the harmless real fd — but Node's real
            // handle.read() resolves fd through ordinary property lookup, not that getter, and would
            // follow the shadow to the dangerous target instead.
            test("Should block handle.read() when the handle's own fd is shadowed to a different, dangerous fd, even though its real target is harmless", async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const dangerousHandle = await fs.promises.open('/proc/self/environ', 'r');
                const dangerousFd = dangerousHandle.fd;
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filehandle-shadow-inverse-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'not a secret');
                const handle = await fs.promises.open(tmpFile, 'r');
                try {
                    Object.defineProperty(handle, 'fd', {
                        value: dangerousFd,
                        configurable: true,
                    });
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        await expect(handle.read(Buffer.alloc(10), 0, 10, 0)).rejects.toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    // close() itself resolves fd the same way read() does — deleting the shadowed
                    // own property first (rather than closing while it's still in place) restores
                    // the real, configurable getter so each handle closes its own true fd, not the
                    // other's.
                    delete (handle as unknown as Record<string, unknown>).fd;
                    await handle.close();
                    await dangerousHandle.close();
                    fs.rmSync(tmpFile, { force: true });
                }
            });

            // A stateful accessor own property could return the true, harmless fd on the one read
            // readNativeFd's own divergence check makes, then a different, dangerous fd on a later
            // read — defeating a "compare the two reads once" defense on its own, since Node's real
            // readFile() would consult the same property again during the actual I/O. Pinning fd as
            // a plain value for the call's duration replaces that property outright, so the getter
            // is never reachable again once the check has run: this asserts both the safe content
            // (proving no leak) and that the getter really was invoked only once, not skipped.
            test("Should read only the fd the check validated, not a stateful getter's later, different answer, even though the getter is never consulted again once pinned", async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const dangerousHandle = await fs.promises.open('/proc/self/environ', 'r');
                const dangerousFd = dangerousHandle.fd;
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filehandle-stateful-shadow-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'not a secret');
                const handle = await fs.promises.open(tmpFile, 'r');
                const benignFd = handle.fd;
                let callCount = 0;
                try {
                    Object.defineProperty(handle, 'fd', {
                        configurable: true,
                        get() {
                            callCount += 1;
                            return callCount === 1 ? benignFd : dangerousFd;
                        },
                    });
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        await expect(handle.readFile('utf8')).resolves.toBe('not a secret');
                    });
                    expect(callCount).toBe(1);
                } finally {
                    delete (handle as unknown as Record<string, unknown>).fd;
                    await handle.close();
                    await dangerousHandle.close();
                    fs.rmSync(tmpFile, { force: true });
                }
            });
        });

        // handle.readFile()/handle.createReadStream()/handle.readableWebStream() are distinct
        // FileHandle prototype methods that don't delegate to each other, so each needs its own
        // guard coverage. Linux-only, matching the .read() guard's tests above, since opening a
        // handle against /proc/self/environ needs /proc to exist.
        describe('FileHandle.prototype.readFile/readv/createReadStream/readableWebStream/readLines guard', () => {
            test('Should block handle.readFile() when the handle is already open against /proc/self/environ', async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const handle = await fs.promises.open('/proc/self/environ', 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        await expect(handle.readFile()).rejects.toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    await handle.close();
                }
            });

            test('Should not block handle.readFile() for an unrelated real file during an active scoped-env window', async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filehandle-readfile-ok-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'hello world');
                const handle = await fs.promises.open(tmpFile, 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        await expect(handle.readFile('utf8')).resolves.toBe('hello world');
                    });
                } finally {
                    await handle.close();
                    fs.rmSync(tmpFile, { force: true });
                }
            });

            // No "any OS" mocked variant here either, same flakiness precedent as readFile()'s own
            // omission above.
            test('Should block handle.readv() when the handle is already open against /proc/self/environ', async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const handle = await fs.promises.open('/proc/self/environ', 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        await expect(handle.readv([Buffer.alloc(10)], 0)).rejects.toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    await handle.close();
                }
            });

            test('Should not block handle.readv() for an unrelated real file during an active scoped-env window', async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filehandle-readv-ok-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'hello world');
                const handle = await fs.promises.open(tmpFile, 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        const buffer = Buffer.alloc(5);
                        const { bytesRead } = await handle.readv([buffer], 0);
                        expect(bytesRead).toBe(5);
                        expect(buffer.toString('utf8')).toBe('hello');
                    });
                } finally {
                    await handle.close();
                    fs.rmSync(tmpFile, { force: true });
                }
            });

            // createReadStream() constructs and returns synchronously (the real read happens lazily
            // as the stream is consumed) — the guard throws synchronously at construction, matching
            // that real contract, rather than surfacing only once the stream is later read from.
            test('Should block handle.createReadStream() when the handle is already open against /proc/self/environ', async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const handle = await fs.promises.open('/proc/self/environ', 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => handle.createReadStream()).toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    await handle.close();
                }
            });

            test('Should not block handle.createReadStream() for an unrelated real file during an active scoped-env window', async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filehandle-stream-ok-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'hello world');
                const handle = await fs.promises.open(tmpFile, 'r');
                let stream: ReturnType<typeof handle.createReadStream> | undefined;
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => {
                            stream = handle.createReadStream();
                            stream.on('error', () => {});
                        }).not.toThrow();
                    });
                } finally {
                    stream?.destroy();
                    await handle.close();
                    fs.rmSync(tmpFile, { force: true });
                }
            });

            // readableWebStream() also constructs and returns synchronously, the same reasoning as
            // createReadStream() above.
            test('Should block handle.readableWebStream() when the handle is already open against /proc/self/environ', async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const handle = await fs.promises.open('/proc/self/environ', 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => handle.readableWebStream()).toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    await handle.close();
                }
            });

            // readableWebStream()'s cancel() already closes the underlying native handle; a
            // subsequent handle.close() double-closes it and aborts the process on Node's own
            // !closed_ assertion, so canceling the stream is this handle's entire cleanup.
            test('Should not block handle.readableWebStream() for an unrelated real file during an active scoped-env window', async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filehandle-webstream-ok-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'hello world');
                const handle = await fs.promises.open(tmpFile, 'r');
                let stream: ReturnType<typeof handle.readableWebStream> | undefined;
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => {
                            stream = handle.readableWebStream();
                        }).not.toThrow();
                    });
                } finally {
                    if (stream) {
                        await stream.cancel();
                    } else {
                        await handle.close();
                    }
                    fs.rmSync(tmpFile, { force: true });
                }
            });

            // readLines() also constructs and returns a readline Interface synchronously, the same
            // reasoning as createReadStream()/readableWebStream() above.
            test('Should block handle.readLines() when the handle is already open against /proc/self/environ', async () => {
                if (process.platform !== 'linux') {
                    return;
                }
                const handle = await fs.promises.open('/proc/self/environ', 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => handle.readLines()).toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    await handle.close();
                }
            });

            test('Should not block handle.readLines() for an unrelated real file during an active scoped-env window', async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `env-guard-filehandle-readlines-ok-${process.pid}.txt`,
                );
                fs.writeFileSync(tmpFile, 'hello\nworld');
                const handle = await fs.promises.open(tmpFile, 'r');
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        let rl: ReturnType<typeof handle.readLines> | undefined;
                        expect(() => {
                            rl = handle.readLines();
                        }).not.toThrow();
                        const lines: string[] = [];
                        for await (const line of rl!) {
                            lines.push(line);
                        }
                        expect(lines).toEqual(['hello', 'world']);
                    });
                } finally {
                    await handle.close();
                    fs.rmSync(tmpFile, { force: true });
                }
            });
        });

        // fs.cpSync's recursive copy calls neither fs.copyFileSync nor fs.readFileSync — Node's
        // internal traversal never re-enters the wrapped entry points above, so a symlink inside the
        // copied tree pointing at /proc/.../environ would have its real content copied to an
        // unguarded destination with no guard ever seeing it.
        describe('cp recursive+dereference guard', () => {
            test('Should block fs.cpSync/fs.cp/fs.promises.cp with recursive+dereference during an active scoped-env window', async () => {
                const srcDir = path.join(os.tmpdir(), `env-guard-cp-recursive-src-${process.pid}`);
                const destDir = path.join(
                    os.tmpdir(),
                    `env-guard-cp-recursive-dest-${process.pid}`,
                );
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(path.join(srcDir, 'a.txt'), 'not a secret');

                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() =>
                            fs.cpSync(srcDir, destDir, { recursive: true, dereference: true }),
                        ).toThrow(/not allowed in backend functions/);

                        const error = await callbackError((callback) =>
                            fs.cp(
                                srcDir,
                                destDir,
                                { recursive: true, dereference: true },
                                callback,
                            ),
                        );
                        expect(error).toBeInstanceOf(Error);
                        expect((error as Error).message).toMatch(
                            /not allowed in backend functions/,
                        );

                        await expect(
                            fs.promises.cp(srcDir, destDir, {
                                recursive: true,
                                dereference: true,
                            }),
                        ).rejects.toThrow(/not allowed in backend functions/);
                    });
                } finally {
                    fs.rmSync(srcDir, { recursive: true, force: true });
                    fs.rmSync(destDir, { recursive: true, force: true });
                }
            });

            test('Should not block a recursive copy WITHOUT dereference during an active scoped-env window', async () => {
                const srcDir = path.join(os.tmpdir(), `env-guard-cp-plain-src-${process.pid}`);
                const destDir = path.join(os.tmpdir(), `env-guard-cp-plain-dest-${process.pid}`);
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(path.join(srcDir, 'a.txt'), 'not a secret');

                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => fs.cpSync(srcDir, destDir, { recursive: true })).not.toThrow();
                    });
                    expect(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8')).toBe(
                        'not a secret',
                    );
                } finally {
                    fs.rmSync(srcDir, { recursive: true, force: true });
                    fs.rmSync(destDir, { recursive: true, force: true });
                }
            });

            test('Should not block fs.cpSync for a single unrelated file with no recursive option at all', async () => {
                const srcFile = path.join(
                    os.tmpdir(),
                    `env-guard-cp-single-src-${process.pid}.txt`,
                );
                const destFile = path.join(
                    os.tmpdir(),
                    `env-guard-cp-single-dest-${process.pid}.txt`,
                );
                fs.writeFileSync(srcFile, 'not a secret');

                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => fs.cpSync(srcFile, destFile)).not.toThrow();
                    });
                    expect(fs.readFileSync(destFile, 'utf8')).toBe('not a secret');
                } finally {
                    fs.rmSync(srcFile, { force: true });
                    fs.rmSync(destFile, { force: true });
                }
            });

            test('Should still block fs.cpSync("/proc/self/environ", dest) via the plain top-level path check', async () => {
                const dest = path.join(
                    os.tmpdir(),
                    `env-guard-cp-still-blocked-${process.pid}.txt`,
                );
                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() => fs.cpSync('/proc/self/environ', dest)).toThrow(
                            /not allowed in backend functions/,
                        );
                    });
                } finally {
                    fs.rmSync(dest, { force: true });
                }
            });

            // The generic makeGuardWrapper machinery forwards a caller's original options object
            // unchanged — without snapshotting, a getter-backed recursive/dereference could report
            // false to this check and true when Node's own fs.cp* implementation reads the same
            // property again internally.
            test('Should read options.recursive/options.dereference exactly once each, not read again by the real implementation', async () => {
                const srcDir = path.join(
                    os.tmpdir(),
                    `env-guard-cp-recursive-once-src-${process.pid}`,
                );
                const destDir = path.join(
                    os.tmpdir(),
                    `env-guard-cp-recursive-once-dest-${process.pid}`,
                );
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(path.join(srcDir, 'a.txt'), 'not a secret');

                let recursiveReadCount = 0;
                let dereferenceReadCount = 0;
                const options = {
                    get recursive() {
                        recursiveReadCount += 1;
                        return true;
                    },
                    get dereference() {
                        dereferenceReadCount += 1;
                        return false;
                    },
                };

                try {
                    await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                        expect(() =>
                            fs.cpSync(srcDir, destDir, options as fs.CopySyncOptions),
                        ).not.toThrow();
                    });
                    expect(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8')).toBe(
                        'not a secret',
                    );
                    // Exactly 1 each: the guard's own snapshotting read, not a second, independent
                    // read by the real cp implementation.
                    expect(recursiveReadCount).toBe(1);
                    expect(dereferenceReadCount).toBe(1);
                } finally {
                    fs.rmSync(srcDir, { recursive: true, force: true });
                    fs.rmSync(destDir, { recursive: true, force: true });
                }
            });
        });

        // The TOCTOU test above verifies "resolve exactly once" by content; this asserts the
        // invocation count directly.
        test('Should read options.fd exactly once, not twice via a stray spread', async () => {
            const tmpFile = path.join(os.tmpdir(), `env-guard-fd-single-read-${process.pid}.txt`);
            fs.writeFileSync(tmpFile, 'not a secret');
            const fd = fs.openSync(tmpFile, 'r');
            let readCount = 0;
            const options = {
                get fd() {
                    readCount += 1;
                    return fd;
                },
            };
            let stream: fs.ReadStream | undefined;

            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    stream = fs.createReadStream('/some/unrelated/path', options);
                    stream.on('error', () => {});
                });
                expect(readCount).toBe(1);
            } finally {
                stream?.destroy();
                fs.closeSync(fd);
                fs.rmSync(tmpFile, { force: true });
            }
        });
    });

    describe('process.report.excludeEnv', () => {
        // @types/node doesn't declare excludeEnv yet even though Node itself has supported it
        // since v22.13.0 — env-guard.ts augments NodeJS.ProcessReport globally, so no cast is
        // needed here; this shares that one canonical type instead of its own separate cast.
        const processReport = process.report;

        // process.report.getReport()/writeReport() read the OS-level environment table directly,
        // bypassing the process.env swap entirely.
        test('Should exclude environmentVariables from process.report.getReport() during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                const report = process.report.getReport();
                const environmentVariables =
                    'environmentVariables' in report ? report.environmentVariables : undefined;
                expect(environmentVariables).toBeUndefined();
            });
        });

        // Regression coverage: redaction must follow the calling continuation's own scope, not a
        // shared, resettable counter — a still-active scope's getReport() call must keep redacting
        // even after an unrelated scope's abandonment (forceResetEnv) has zeroed that counter.
        test("Should keep redacting a still-active scope's own getReport() call after an unrelated scope's abandonment clears the shared counter", async () => {
            let resolveOuter: (() => void) | undefined;
            let reportDuringOuter: ReturnType<typeof process.report.getReport> | undefined;
            const outer = runWithScopedEnv({ PATH: '/outer' }, async () => {
                await new Promise<void>((resolve) => {
                    resolveOuter = resolve;
                });
                reportDuringOuter = process.report.getReport();
            });

            // Simulates an unrelated execution's abandonment path forcing the shared counter to
            // zero while `outer`'s own scope is still active.
            forceResetEnv();

            resolveOuter?.();
            await outer;

            const environmentVariables =
                reportDuringOuter && 'environmentVariables' in reportDuringOuter
                    ? reportDuringOuter.environmentVariables
                    : undefined;
            expect(environmentVariables).toBeUndefined();
        });

        // On Node >=22.13.0, excludeEnv must delegate to Node's own native setter, not a
        // disconnected JS shadow that would have zero effect on a native, non-JS-triggered report
        // (--report-on-signal etc). Node's native setter throws for a non-boolean; a disconnected
        // shadow would silently accept anything, making this observable without spawning a
        // subprocess to send a real signal.
        function nodeSupportsNativeExcludeEnv(): boolean {
            const [major, minor] = process.version.slice(1).split('.').map(Number);
            return major > 22 || (major === 22 && minor >= 13);
        }

        function setExcludeEnvToInvalidValue(report: NodeJS.ProcessReport, value: unknown): void {
            report.excludeEnv = value as boolean;
        }

        test("Should delegate to Node's native excludeEnv setter, not a disconnected JS shadow, on Node versions that have one", () => {
            if (!nodeSupportsNativeExcludeEnv()) {
                return;
            }
            const before = processReport.excludeEnv;
            try {
                expect(() => setExcludeEnvToInvalidValue(processReport, 'not-a-boolean')).toThrow();
            } finally {
                processReport.excludeEnv = before;
            }
        });

        test('Should reject a customer function reassigning process.report.excludeEnv from inside its own scope', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => {
                    process.report.excludeEnv = false;
                }).toThrow(/not allowed in backend functions/);
            });
        });

        test('Should restore the real excludeEnv value after the scoped-env window closes', async () => {
            const before = processReport.excludeEnv;

            await runWithScopedEnv({ PATH: '/scoped' }, async () => undefined);

            expect(processReport.excludeEnv).toBe(before);
        });

        // excludeEnv is process-wide — an outside caller's write made while a DIFFERENT scope is
        // still active must defer rather than apply immediately, or it would disarm redaction for
        // that still-running scope and then get clobbered back by its cleanup.
        test('Should defer an outside write made while a scope is active, applying it once that scope closes instead of the pre-scope original', async () => {
            let resolveScope: (() => void) | undefined;
            const scope = runWithScopedEnv({ PATH: '/scoped' }, async () => {
                await new Promise<void>((resolve) => {
                    resolveScope = resolve;
                });
            });

            // Made from outside the scope's own continuation — an unrelated caller, not the customer function.
            processReport.excludeEnv = false;
            // Not applied yet: the scope is still active, so the real flag stays armed for it.
            expect(processReport.excludeEnv).toBe(true);

            resolveScope?.();
            await scope;

            // Applied once the scope closed, not clobbered back to whatever excludeEnv held before it opened.
            expect(processReport.excludeEnv).toBe(false);
        });

        test("Should not clobber a developer's own excludeEnv=true setting made before the scoped-env window opened", async () => {
            const before = processReport.excludeEnv;
            processReport.excludeEnv = true;
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => undefined);
                expect(processReport.excludeEnv).toBe(true);
            } finally {
                processReport.excludeEnv = before;
            }
        });

        // Exercises the writeReport() JS-level redaction wrap, which is the only thing that strips
        // environmentVariables on Node <22.13 (CI pins 20.19.4) — process.report.excludeEnv is a
        // no-op there, so this wrap's own redaction is real coverage of current behavior on CI, not
        // just on this repo's newer local dev Node version where excludeEnv is natively wired up.
        test('Should exclude environmentVariables from process.report.writeReport() during an active scoped-env window', async () => {
            const tmpFile = path.join(os.tmpdir(), `env-guard-report-${process.pid}.json`);
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    process.report.writeReport(tmpFile);
                });

                const rawReport = fs.readFileSync(tmpFile, 'utf8');
                const written: { environmentVariables?: unknown } = JSON.parse(rawReport);
                expect(written.environmentVariables).toBeUndefined();
            } finally {
                fs.rmSync(tmpFile, { force: true });
            }
        });

        // Regression coverage: an explicit filename is written directly via getReport(), never read
        // back off disk — the read-back-and-rewrite approach the no-fileName branch still uses has a
        // real window where the unredacted file exists on disk. Absence of fs.readFileSync is what
        // distinguishes the two; the final-content-only test above would pass under either.
        test('Should never read the report file back off disk for an explicit filename, proving the redacted content is written directly rather than read-back-and-rewritten', async () => {
            const tmpFile = path.join(os.tmpdir(), `env-guard-report-direct-${process.pid}.json`);
            const readFileSyncSpy = jest.spyOn(fs, 'readFileSync');
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    process.report.writeReport(tmpFile);
                });

                expect(readFileSyncSpy).not.toHaveBeenCalledWith(tmpFile, expect.anything());
                const written: { environmentVariables?: unknown } = JSON.parse(
                    fs.readFileSync(tmpFile, 'utf8'),
                );
                expect(written.environmentVariables).toBeUndefined();
            } finally {
                readFileSyncSpy.mockRestore();
                fs.rmSync(tmpFile, { force: true });
            }
        });

        // Regression coverage: onScopeStarted's handle must discharge only its own token, unlike
        // forceResetEnv() — abandoning a hung scope must never disarm a different, concurrently
        // active scope's own excludeEnv protection.
        test("Should let onScopeStarted's handle abandon only its own scope, leaving a concurrently active scope's excludeEnv protection armed", async () => {
            const before = processReport.excludeEnv;

            let resolveHung: (() => void) | undefined;
            let hungHandle: { abandon: () => void } | undefined;
            const hung = runWithScopedEnv(
                { PATH: '/hung' },
                async () => {
                    await new Promise<void>((resolve) => {
                        resolveHung = resolve;
                    });
                },
                (handle) => {
                    hungHandle = handle;
                },
            );
            expect(hungHandle).toBeDefined();

            let resolveActive: (() => void) | undefined;
            let excludeEnvAfterAbandon: boolean | undefined;
            const active = runWithScopedEnv({ PATH: '/active' }, async () => {
                await new Promise<void>((resolve) => {
                    resolveActive = resolve;
                });
                excludeEnvAfterAbandon = processReport.excludeEnv;
            });

            hungHandle?.abandon();
            // Still armed: `active`'s own scope is unaffected by abandoning the unrelated hung one.
            expect(processReport.excludeEnv).toBe(true);

            resolveActive?.();
            await active;
            expect(excludeEnvAfterAbandon).toBe(true);
            // Restored once `active` closes, proving hung's token was actually discharged by
            // abandon() above — if it lingered in the set, this would still read `true`.
            expect(processReport.excludeEnv).toBe(before);

            resolveHung?.();
            await hung;
        });

        // Regression coverage: if a zombie scope's runWithScopedEnv finally fires AFTER
        // forceResetEnv() already cleared it (the ordering a test harness's afterEach produces
        // against a scope deliberately left open), its disarmScope(token) call must find its own
        // token already gone and no-op, rather than corrupting state a later scope relies on.
        test("Should still arm excludeEnv protection for a later scope after forceResetEnv() races a zombie scope's own decrement", async () => {
            let resolveZombie: (() => void) | undefined;
            const zombie = runWithScopedEnv({ PATH: '/zombie' }, async () => {
                await new Promise<void>((resolve) => {
                    resolveZombie = resolve;
                });
            });

            forceResetEnv();

            resolveZombie?.();
            await zombie;

            await runWithScopedEnv({ PATH: '/fresh' }, async () => {
                expect(processReport.excludeEnv).toBe(true);
            });
        });

        // Regression coverage: a zombie's finally firing after forceResetEnv() has run — but while a
        // later, unrelated scope is still active — must find its own token already cleared and
        // no-op, not decrement/restore against that later scope's still-active state.
        test("Should not let a zombie scope's post-forceResetEnv finally disarm excludeEnv for a still-active later scope", async () => {
            const before = processReport.excludeEnv;

            let resolveZombie: (() => void) | undefined;
            const zombie = runWithScopedEnv({ PATH: '/zombie' }, async () => {
                await new Promise<void>((resolve) => {
                    resolveZombie = resolve;
                });
            });

            forceResetEnv();

            let resolveLater: (() => void) | undefined;
            let excludeEnvMidFlight: boolean | undefined;
            const later = runWithScopedEnv({ PATH: '/later' }, async () => {
                excludeEnvMidFlight = processReport.excludeEnv;
                await new Promise<void>((resolve) => {
                    resolveLater = resolve;
                });
                // Resumed after the zombie's own finally has already fired below — must still see
                // itself as protected, not disarmed by the zombie's unrelated, stale cleanup.
                return processReport.excludeEnv;
            });
            expect(excludeEnvMidFlight).toBe(true);

            resolveZombie?.();
            await zombie;
            expect(processReport.excludeEnv).toBe(true);

            resolveLater?.();
            await expect(later).resolves.toBe(true);
            expect(processReport.excludeEnv).toBe(before);
        });
    });

    // Regression coverage for a review finding: the shared state above is stashed on the public
    // `fs` module so re-evaluations of this file converge on one instance, but that also makes it
    // reachable via `require('fs')` by anything else in the same process, including a backend
    // function's own third-party dependencies. A raw `realEnv` field there would hand out the real
    // environment directly; a raw AsyncLocalStorage instance would let a caller disarm scope
    // detection process-wide via its own `.disable()`. Every value on the registry must instead be
    // a function whose own logic re-applies the real scope check before doing anything sensitive.
    describe('fs-keyed shared registry exposure', () => {
        const processReport = process.report;

        function getSharedRegistryEntry(): Record<string, unknown> {
            return (fs as unknown as Record<symbol, Record<string, unknown>>)[
                Symbol.for('@dd/apps-plugin/env-guard shared-state')
            ];
        }

        test('Should expose only functions on the fs-keyed shared registry, never a raw realEnv/AsyncLocalStorage/counter field', () => {
            const shared = getSharedRegistryEntry();
            expect(Object.keys(shared).length).toBeGreaterThan(0);
            for (const value of Object.values(shared)) {
                expect(typeof value).toBe('function');
            }
        });

        test('Should return the scoped view, not the real environment, from the registry\'s own accessor when called from inside an active scope — reproducing require("fs")[symbol].realEnv.DD_API_KEY from review', async () => {
            process.env.DD_API_KEY = 'dev-server-real-secret';
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    const shared = getSharedRegistryEntry();
                    const currentEnv = (shared.getCurrentEnv as () => Record<string, string>)();
                    expect(currentEnv.DD_API_KEY).toBeUndefined();
                    expect(currentEnv.PATH).toBe('/scoped');
                });
            } finally {
                delete process.env.DD_API_KEY;
            }
        });

        test("Should not let a forged token disarm an active scope's excludeEnv protection via the registry's own disarmScope", async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                const shared = getSharedRegistryEntry();
                (shared.disarmScope as (token: symbol) => void)(Symbol('forged token'));
                expect(processReport.excludeEnv).toBe(true);
            });
        });
    });
});
