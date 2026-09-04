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

describe('env-guard', () => {
    installFakeProcessEnv({
        PATH: '/usr/bin',
        HOME: '/home/dev',
        NODE_ENV: 'test',
        TMPDIR: '/tmp',
    });

    describe('buildScopedEnv', () => {
        // Captured in beforeAll, not as a describe-body constant: a describe body runs at Jest's
        // "collection time", before the outer beforeAll above has swapped process.env to the fake
        // baseline, so a plain `const originalEnv = process.env` here would still capture the real,
        // unswapped environment. A value snapshot via spread, not a reference to process.env
        // itself: by this point process.env is env-guard.ts's own Proxy, and restoring via that
        // same reference later is a no-op self-reassignment under the Proxy's own setter guard.
        let originalEnv: typeof process.env;
        beforeAll(() => {
            originalEnv = { ...process.env };
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

        // A zombie execution's own continuation stays bound to the scope it started with via
        // AsyncLocalStorage, so it can never observe or corrupt a newer, unrelated execution's
        // separate scope — mirrors network-guard.ts's abandon-not-cancel protection, solved the same
        // way (blockedContext) for network access. Abandonment needs no explicit action here at all:
        // local-execution.ts's timeout handler (abandonExecutionAndRejectWith) never touches env
        // scoping, since there's no shared global state for a timed-out execution to force back. Each
        // scope's own view is captured from INSIDE its own callback (a return value or a side-channel
        // set synchronously before its own first await), not read from the test's outer continuation —
        // AsyncLocalStorage only propagates through continuations spawned from within a run()
        // callback, never back out to whatever merely called runWithScopedEnv without awaiting it.
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
            // continuation is still pending (the timeout handler abandons it without cancelling it —
            // see local-execution.ts's own "abandoned, not canceled" model). Its own view is captured
            // synchronously, before its first await, so it's set within the same tick runWithScopedEnv
            // is called in.
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

        // Other code — a test's own isolation swap, a dotenv-style tool — can and does reassign
        // process.env wholesale after this module first loads; the guard must treat whatever it
        // currently is as the new real fallback rather than silently going stale and unguarded.
        test('Should adopt a wholesale process.env reassignment as the new real fallback, not a stale one', async () => {
            process.env = { PATH: '/reassigned', SOME_NEW_VAR: 'set-after-reassignment' };

            const seenPath = await runWithScopedEnv(
                { PATH: '/scoped' },
                async () => process.env.PATH,
            );
            expect(seenPath).toBe('/scoped');

            expect(process.env.PATH).toBe('/reassigned');
            expect(process.env.SOME_NEW_VAR).toBe('set-after-reassignment');
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
        // something, restore it" pattern this test file's own beforeAll/afterAll uses — capturing
        // process.env captures a reference to the Proxy itself, so restoring it later reassigns the
        // Proxy as its own currentEnv() fallback, and every subsequent unscoped read would recurse
        // into the same trap forever trying to resolve through itself.
        test('Should not infinitely recurse when process.env is captured and reassigned back to itself', () => {
            const captured = process.env;
            process.env = captured;

            expect(() => process.env.PATH).not.toThrow();
        });

        // Reflect.get throws for a non-object value, and isEnvProxy() is the setter's first check on
        // whatever gets assigned — without its own object/null guard, `process.env = null` (or
        // undefined) would surface as an unhandled native TypeError instead of either this file's own
        // clear rejection message (from inside a scope) or a graceful no-op (from outside one).
        test('Should not throw a native TypeError when process.env is reassigned to null or undefined', () => {
            const before = process.env;

            try {
                expect(() => {
                    process.env = null as unknown as NodeJS.ProcessEnv;
                }).not.toThrow();
                expect(() => {
                    process.env = undefined as unknown as NodeJS.ProcessEnv;
                }).not.toThrow();
            } finally {
                process.env = before;
            }
        });

        // Regression coverage: this file gets evaluated more than once in practice (Jest's
        // per-test-file module isolation, or a duplicated bundled copy) — two jest.isolateModules()
        // evaluations here reproduce that directly instead of relying on this test FILE's own single
        // static import, whose Proxy-install history depends on unrelated preceding tests. The real
        // secret is set BEFORE the first instance ever installs its Proxy, so that instance's own
        // realEnv snapshot is guaranteed to capture it, matching how the bug actually manifests: a
        // later-created instance's own runWithScopedEnv call must still hide it. Matches
        // network-guard.ts's own getSharedContext() reasoning for why this file needs shared state.
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
    });

    // Regression coverage for the /proc/.../environ backing-store bypass: swapping process.env alone doesn't stop reads of the kernel-backed environ file directly on Linux.
    describe('environ-file guard', () => {
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

        test('Should block the callback-style fs.readFile("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.readFile('/proc/self/environ', () => {})).toThrow(
                    /not allowed in backend functions/,
                );
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

        // options.fd can be an accessor property whose getter returns a different value on each
        // read. If the guard read it once for its own check and then let the real call read it
        // again independently, a getter could show the check a safe fd and hand the real
        // implementation's own, separate read a different, real target — the fix instead resolves
        // options.fd exactly once and reuses that single materialized value for the real call too,
        // so whatever the getter would return on a later read is never actually reached. Verified
        // by content, not by expecting a throw: the correct fixed behavior is that the read
        // proceeds safely using only the first value seen, not that it errors.
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

        test('Should block fs.openSync/fs.open("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                expect(() => fs.openSync('/proc/self/environ', 'r')).toThrow(
                    /not allowed in backend functions/,
                );
                expect(() => fs.open('/proc/self/environ', 'r', () => {})).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        test('Should block fs.promises.open("/proc/self/environ") during an active scoped-env window', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                await expect(fs.promises.open('/proc/self/environ', 'r')).rejects.toThrow(
                    /not allowed in backend functions/,
                );
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

        // A symlink pointing at /proc/self/environ has its own, unrelated literal path, so
        // isEnvironPath() must resolve via realpathSync before matching the regex — fs.readFileSync
        // and friends follow symlinks transparently, so matching only the literal string would let
        // this through. Only runs on Linux, where /proc/self/environ exists to symlink to and read
        // through — local dev on macOS has no /proc to reproduce this against.
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

        test('Should block the callback-style fs.copyFile("/proc/self/environ") during an active scoped-env window', async () => {
            const dest = path.join(os.tmpdir(), `env-guard-copy-cb-${process.pid}.txt`);
            try {
                await runWithScopedEnv({ PATH: '/scoped' }, async () => {
                    expect(() => fs.copyFile('/proc/self/environ', dest, () => {})).toThrow(
                        /not allowed in backend functions/,
                    );
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

        // new fs.ReadStream(path) constructs directly, bypassing the createReadStream factory the
        // guard above wraps — verified separately since the two are distinct entry points.
        // @types/node declares no (path, options) constructor for ReadStream (it inherits
        // Readable's), so Reflect.construct invokes the real, untyped signature directly instead of
        // fighting that gap with a cast. The unrelated-file case attaches a no-op error listener and
        // destroys the stream itself: its underlying async open can still be in flight when the
        // test's own finally block deletes the file, which would otherwise surface as an unhandled
        // 'error' event and crash the process rather than fail the assertion.
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

        // On Node >=22.13.0, excludeEnv must delegate to Node's OWN native setter, not a disconnected
        // JS shadow variable — a shadow would leave the JS-visible value read back correctly while
        // having zero effect on what a native, non-JS-triggered report (--report-on-signal etc.)
        // actually contains, since that path reads Node's real internal flag directly. Node's native
        // setter validates its argument type (throwing for a non-boolean); a disconnected shadow
        // would silently accept anything, so this failure mode is observable without needing to
        // spawn a subprocess and send it a real signal.
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

        // Regression coverage: forceResetEnv() zeroes activeScopeCount unconditionally as a test-only
        // backstop. If a zombie scope's own runWithScopedEnv finally fires AFTER forceResetEnv()
        // already ran (exactly the ordering a test harness's afterEach can produce against a scope a
        // test deliberately left open), an unclamped decrement drives the count negative. Every later
        // scope's own increment then lands on 0 instead of 1, so the `=== 1` branch that arms
        // excludeEnv protection never fires again for the rest of the process — a future customer
        // function's process.report call would go unredacted with no error or warning.
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

        // Regression coverage: activeScopeCount/excludeEnvArmed are shared by every concurrent scope,
        // not per-call. Without resetEpoch, a zombie's own finally firing AFTER forceResetEnv() has
        // already run — but WHILE a later, unrelated scope is still active — would decrement and
        // restore against that later scope's own state instead of its own, disarming excludeEnv
        // protection while that scope's customer function is still running.
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
});
