// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildScopedEnv, forceResetEnv, runWithScopedEnv } from './env-guard';

// Hard backstop: process.env is a process-wide singleton, so a test that leaves it swapped (e.g. a bug skipping its own restore) would otherwise leak into every later test in this Jest worker.
afterEach(() => {
    forceResetEnv();
});

describe('env-guard', () => {
    describe('buildScopedEnv', () => {
        const originalEnv = process.env;

        afterEach(() => {
            process.env = originalEnv;
        });

        test('Should include only the safe allowlisted keys from the real environment, dropping everything else', () => {
            process.env = {
                PATH: '/usr/bin',
                HOME: '/home/dev',
                NODE_ENV: 'development',
                TMPDIR: '/tmp',
                AWS_SECRET_ACCESS_KEY: 'super-secret-aws-key',
                DD_API_KEY: 'the-dev-servers-own-api-key',
                SOME_RANDOM_SHELL_VAR: 'whatever',
            };

            const scoped = buildScopedEnv({});

            expect(scoped).toEqual({
                PATH: '/usr/bin',
                HOME: '/home/dev',
                NODE_ENV: 'development',
                TMPDIR: '/tmp',
            });
        });

        test('Should merge in the provided Custom Credentials under their own names', () => {
            process.env = { PATH: '/usr/bin' };

            const scoped = buildScopedEnv({ STRIPE_API_KEY: 'sk_test_123' });

            expect(scoped).toEqual({ PATH: '/usr/bin', STRIPE_API_KEY: 'sk_test_123' });
        });

        test('Should omit an allowlisted key entirely when unset in the real environment, rather than including it as undefined', () => {
            process.env = { PATH: '/usr/bin' };

            const scoped = buildScopedEnv({});

            expect('HOME' in scoped).toBe(false);
            expect('NODE_ENV' in scoped).toBe(false);
            expect('TMPDIR' in scoped).toBe(false);
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
            const realEnv = process.env;
            await runWithScopedEnv({ PATH: '/usr/bin' }, async () => undefined);
            expect(process.env).toBe(realEnv);
        });

        test('Should restore the real process.env even when fn throws', async () => {
            const realEnv = process.env;
            await expect(
                runWithScopedEnv({ PATH: '/usr/bin' }, async () => {
                    throw new Error('customer function boom');
                }),
            ).rejects.toThrow('customer function boom');
            expect(process.env).toBe(realEnv);
        });

        // Mirrors network-guard.ts's abandon-not-cancel protection: an abandoned execution's late settlement must not restore the real env out from under a newer, still-active scoped window.
        test("Should not let an abandoned runWithScopedEnv call's late restore corrupt a newer, currently-active scoped window", async () => {
            const realEnv = process.env;

            let resolveAbandoned: (() => void) | undefined;
            const abandoned = runWithScopedEnv(
                { PATH: '/abandoned' },
                () =>
                    new Promise<void>((resolve) => {
                        resolveAbandoned = resolve;
                    }),
            );

            // Simulates the timeout handler abandoning this execution, exactly like local-execution.ts's timer callback.
            forceResetEnv();
            expect(process.env).toBe(realEnv);

            // A second, newer execution starts its own scoped-env window.
            let resolveCurrent: (() => void) | undefined;
            const current = runWithScopedEnv(
                { PATH: '/current' },
                () =>
                    new Promise<void>((resolve) => {
                        resolveCurrent = resolve;
                    }),
            );
            expect(process.env.PATH).toBe('/current');

            // The abandoned execution's fn() finally settles; its finally block must not restore the real env out from under the still-running newer window.
            resolveAbandoned?.();
            await abandoned;
            expect(process.env.PATH).toBe('/current');

            resolveCurrent?.();
            await current;
            expect(process.env).toBe(realEnv);
        });

        // Mirrors network-guard.ts's savedX-consumed-not-just-restored invariant: an idle forceResetEnv() must not reinstall a stale snapshot over a real env change made since.
        test('Should not let a later, idle forceResetEnv() reinstall a stale snapshot over a real env change made since', async () => {
            const realEnv = process.env;

            await runWithScopedEnv({ PATH: '/scoped' }, async () => undefined);
            expect(process.env).toBe(realEnv);

            // A real, legitimate change to process.env unrelated to this guard, made after its own window already closed.
            process.env = { ...realEnv, SOME_NEW_VAR: 'set-after-guard-closed' };
            const updatedRealEnv = process.env;

            // Guard is idle (nothing currently scoped), so this must be a true no-op.
            forceResetEnv();

            expect(process.env).toBe(updatedRealEnv);
            process.env = realEnv;
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
                expect(() => fs.readFileSync(Buffer.from('/proc/self/environ'))).toThrow(
                    /not allowed in backend functions/,
                );
                expect(() => fs.readFileSync(new URL('file:///proc/self/environ'))).toThrow(
                    /not allowed in backend functions/,
                );
            });
        });

        test('Should not block reading /proc/self/environ once the scoped-env window has closed', async () => {
            await runWithScopedEnv({ PATH: '/scoped' }, async () => undefined);

            // Off Linux, /proc doesn't exist; the assertion is only that our guard doesn't fire once idle, not that the read succeeds.
            expect(() => fs.readFileSync('/proc/self/environ')).not.toThrow(
                /not allowed in backend functions/,
            );
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
    });
});
