// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import child_process from 'child_process';
import net from 'net';

import { runAllowed, runBlocked } from './network-guard';

describe('network-guard', () => {
    describe('runBlocked', () => {
        test('Should block a raw net.Socket.connect() call made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    new net.Socket().connect(80, 'example.com');
                }),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should block a fetch() call made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    await fetch('https://example.com');
                }),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should block child_process.spawn/exec/execSync made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    child_process.spawn('curl', ['https://example.com']);
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
            await expect(
                runBlocked(async () => {
                    child_process.exec('curl https://example.com');
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
            await expect(
                runBlocked(async () => {
                    child_process.execSync('curl https://example.com');
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
        });

        test('Should restore the real net.Socket.connect after fn resolves', async () => {
            const realConnect = net.Socket.prototype.connect;
            await runBlocked(async () => undefined);
            expect(net.Socket.prototype.connect).toBe(realConnect);
        });

        test('Should restore the real fetch after fn resolves', async () => {
            const realFetch = globalThis.fetch;
            await runBlocked(async () => undefined);
            expect(globalThis.fetch).toBe(realFetch);
        });

        test('Should restore the real network functions even when fn throws', async () => {
            const realConnect = net.Socket.prototype.connect;
            const realFetch = globalThis.fetch;
            await expect(
                runBlocked(async () => {
                    throw new Error('customer function boom');
                }),
            ).rejects.toThrow('customer function boom');
            expect(net.Socket.prototype.connect).toBe(realConnect);
            expect(globalThis.fetch).toBe(realFetch);
        });

        test('Should not block a subsequent, separate runBlocked call after an earlier one already restored', async () => {
            await expect(
                runBlocked(async () => {
                    throw new Error('first execution boom');
                }),
            ).rejects.toThrow('first execution boom');

            // Confirms the guard doesn't leak a "still blocked" state across
            // executions the way a naive boolean (never reset on throw)
            // could.
            const result = await runBlocked(async () => 'second execution result');
            expect(result).toBe('second execution result');
        });
    });

    describe('runAllowed', () => {
        test('Should let a real network call through when nested inside runBlocked', async () => {
            const fetchMock = jest.fn().mockResolvedValue('real response');
            const originalFetch = globalThis.fetch;
            (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

            try {
                const result = await runBlocked(async () =>
                    runAllowed(async () => fetch('https://api.datadoghq.com')),
                );
                expect(result).toBe('real response');
                expect(fetchMock).toHaveBeenCalledWith('https://api.datadoghq.com');
            } finally {
                (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
            }
        });

        test('Should re-block network once the allowed call finishes, while the outer execution is still running', async () => {
            await runBlocked(async () => {
                await runAllowed(async () => undefined);
                await expect(fetch('https://example.com')).rejects.toThrow(
                    /Network access is not allowed/,
                );
            });
        });

        test('Should keep network allowed while two concurrent allowed calls overlap, and only re-block once the last one finishes', async () => {
            const fetchMock = jest.fn().mockResolvedValue('ok');
            const originalFetch = globalThis.fetch;
            (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
            const order: string[] = [];

            try {
                await runBlocked(async () => {
                    const first = runAllowed(async () => {
                        order.push('first-start');
                        await new Promise((r) => setTimeout(r, 20));
                        order.push('first-end');
                    });
                    const second = runAllowed(async () => {
                        order.push('second-start');
                        // Finishes before `first` — if re-blocking were a naive
                        // boolean instead of a depth counter, this would
                        // re-block network while `first` is still mid-flight.
                        order.push('second-end');
                    });

                    await second;
                    // Network must still be allowed here: `first` is still in flight.
                    await expect(fetch('https://example.com')).resolves.toBe('ok');
                    await first;
                });
            } finally {
                (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
            }

            expect(order).toEqual(['first-start', 'second-start', 'second-end', 'first-end']);
            expect(fetchMock).toHaveBeenCalledWith('https://example.com');
        });

        test('Should still re-block after the allowed call finishes even if it throws', async () => {
            await runBlocked(async () => {
                await expect(
                    runAllowed(async () => {
                        throw new Error('action call failed');
                    }),
                ).rejects.toThrow('action call failed');
                await expect(fetch('https://example.com')).rejects.toThrow(
                    /Network access is not allowed/,
                );
            });
        });
    });
});
