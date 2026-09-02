// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import child_process from 'child_process';
import dgram from 'dgram';
import dns from 'dns';
import net from 'net';
import { promisify } from 'util';
import worker_threads from 'worker_threads';

import { forceReset, runAllowed, runBlocked } from './network-guard';

// net/fetch/child_process are real, process-wide singletons, so a test that leaves them patched would leak into every later test in the same Jest worker.
afterEach(() => {
    forceReset();
});

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

        test('Should block dgram.Socket send/connect made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    dgram.createSocket('udp4').send('data', 80, 'example.com');
                }),
            ).rejects.toThrow(/Network access is not allowed/);

            await expect(
                runBlocked(async () => {
                    dgram.createSocket('udp4').connect(80, 'example.com');
                }),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should block net.Server.listen() and dgram.Socket.bind() made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    net.createServer().listen(0);
                }),
            ).rejects.toThrow(/Network access is not allowed/);

            await expect(
                runBlocked(async () => {
                    dgram.createSocket('udp4').bind(0);
                }),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should let net.Server.listen() and dgram.Socket.bind() through outside a blocked scope', async () => {
            const server = net.createServer();
            await new Promise<void>((resolve, reject) => {
                server.once('listening', resolve);
                server.once('error', reject);
                server.listen(0);
            });
            expect(server.listening).toBe(true);
            server.close();

            const socket = dgram.createSocket('udp4');
            await new Promise<void>((resolve, reject) => {
                socket.once('listening', resolve);
                socket.once('error', reject);
                socket.bind(0);
            });
            expect(socket.address().port).toBeGreaterThan(0);
            socket.close();
        });

        // dns.resolve*/dns.promises.resolve*/dns.Resolver/dns.promises.Resolver all go through Node's
        // native c-ares channel, never touching the patched net.Socket/dgram.Socket methods above —
        // each of the 4 surfaces is a genuinely distinct function object, not an alias of another.
        // dns.lookup is deliberately excluded here — a separate, already-decided-on Out-of-Scope call.
        describe('dns resolver methods', () => {
            test('Should block dns.resolve4 on all 4 surfaces (plain, promises, Resolver, promises.Resolver) inside fn', async () => {
                await expect(
                    runBlocked(async () => {
                        dns.resolve4('example.com', () => undefined);
                    }),
                ).rejects.toThrow(/Network access is not allowed/);

                await expect(
                    runBlocked(async () => {
                        await dns.promises.resolve4('example.com');
                    }),
                ).rejects.toThrow(/Network access is not allowed/);

                await expect(
                    runBlocked(async () => {
                        new dns.Resolver().resolve4('example.com', () => undefined);
                    }),
                ).rejects.toThrow(/Network access is not allowed/);

                await expect(
                    runBlocked(async () => {
                        await new dns.promises.Resolver().resolve4('example.com');
                    }),
                ).rejects.toThrow(/Network access is not allowed/);
            });

            test('Should block dns.resolveTxt made inside fn', async () => {
                await expect(
                    runBlocked(async () => {
                        dns.resolveTxt('example.com', () => undefined);
                    }),
                ).rejects.toThrow(/Network access is not allowed/);
            });

            test('Should block dns.promises.reverse made inside fn', async () => {
                await expect(
                    runBlocked(async () => {
                        await dns.promises.reverse('127.0.0.1');
                    }),
                ).rejects.toThrow(/Network access is not allowed/);
            });

            // Matches guardFetch's contract: dns.promises.*/dns.promises.Resolver.prototype.* always
            // return a Promise, so a blocked call must reject it rather than throw synchronously — a
            // caller chaining `.catch()` directly (not inside an `await`/try-catch) would otherwise be
            // left with an uncaught exception instead of a catchable rejection.
            test('Should reject rather than throw synchronously from dns.promises.resolve4 and dns.promises.Resolver.prototype.resolve4 when blocked', async () => {
                await runBlocked(async () => {
                    // The synchronous act of *calling* the guarded method must not throw — only the
                    // Promise it returns should reject.
                    let plainCallResult: Promise<unknown> | undefined;
                    expect(() => {
                        plainCallResult = dns.promises.resolve4('example.com');
                    }).not.toThrow();
                    expect(plainCallResult).toBeInstanceOf(Promise);
                    await expect(plainCallResult).rejects.toThrow(/Network access is not allowed/);

                    // A caller chaining `.catch()` directly onto the call (not awaiting/try-catching
                    // it) must have that handler actually fire, proving a real rejection occurred
                    // rather than an uncaught synchronous exception the `.catch()` never attaches to.
                    let caught: unknown;
                    expect(() => {
                        dns.promises.resolve4('example.com').catch((err: unknown) => {
                            caught = err;
                        });
                    }).not.toThrow();
                    await Promise.resolve();
                    expect(caught).toBeInstanceOf(Error);
                    expect((caught as Error).message).toMatch(/Network access is not allowed/);

                    // Same contract on the Resolver-instance surface.
                    const resolver = new dns.promises.Resolver();
                    let resolverCallResult: Promise<unknown> | undefined;
                    expect(() => {
                        resolverCallResult = resolver.resolve4('example.com');
                    }).not.toThrow();
                    expect(resolverCallResult).toBeInstanceOf(Promise);
                    await expect(resolverCallResult).rejects.toThrow(
                        /Network access is not allowed/,
                    );
                });
            });

            test('Should restore the real dns.resolve4 after fn resolves', async () => {
                const realResolve4 = dns.resolve4;
                await runBlocked(async () => undefined);
                expect(dns.resolve4).toBe(realResolve4);
            });

            test('Should let dns.resolve4 pass through to the underlying implementation outside a blocked scope', async () => {
                const originalResolve4 = dns.resolve4;
                const mockResolve4 = jest.fn(
                    (hostname: string, callback: (...a: never[]) => void) =>
                        (callback as (err: null, addresses: string[]) => void)(null, ['127.0.0.1']),
                );
                (dns as unknown as { resolve4: unknown }).resolve4 = mockResolve4;

                try {
                    await new Promise<void>((resolve) => {
                        dns.resolve4('example.com', () => resolve());
                    });
                    expect(mockResolve4).toHaveBeenCalled();
                } finally {
                    (dns as unknown as { resolve4: unknown }).resolve4 = originalResolve4;
                }
            });
        });

        // Global WebSocket doesn't exist on every Node version this repo supports (CI pins Node 20,
        // where it's absent) — skip rather than fail on a version where there's nothing to guard.
        const GlobalWebSocket = (
            globalThis as unknown as { WebSocket?: new (url: string) => unknown }
        ).WebSocket;
        const testIfWebSocketExists = GlobalWebSocket ? test : test.skip;
        testIfWebSocketExists('Should block a new WebSocket(...) call made inside fn', async () => {
            // eslint-disable-next-line jest/no-standalone-expect -- testIfWebSocketExists is test/test.skip, the rule just can't see through the variable
            await expect(
                runBlocked(async () => {
                    new (GlobalWebSocket as new (url: string) => unknown)('ws://example.com');
                }),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should block child_process.spawn/spawnSync/exec/execSync/execFile/execFileSync/fork made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    child_process.spawn('curl', ['https://example.com']);
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
            await expect(
                runBlocked(async () => {
                    child_process.spawnSync('curl', ['https://example.com']);
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
            await expect(
                runBlocked(async () => {
                    child_process.execFile('curl', ['https://example.com']);
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
            await expect(
                runBlocked(async () => {
                    child_process.execFileSync('curl', ['https://example.com']);
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
            await expect(
                runBlocked(async () => {
                    child_process.fork('./some-script.js');
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
        });

        // Node's native exec/execFile carry a `util.promisify.custom` implementation resolving `{stdout, stderr}`; a plain wrapper function silently drops that symbol (it lives on the specific function object, not something a fresh function inherits), so `promisify()` falls back to its generic single-value behavior instead — this repo's own `@dd/tools` execute() helper (`promisify(execFile)`) depends on the real shape.
        test('Should resolve promisify(execFile) to the real {stdout, stderr} shape, not a bare string, when not blocked', async () => {
            const execFileP = promisify(child_process.execFile);
            const result = await execFileP('node', ['-e', 'console.log("hi")']);
            expect(result).toEqual(
                expect.objectContaining({ stdout: expect.stringContaining('hi') }),
            );
        });

        test('Should still block promisify(execFile) inside a runBlocked scope', async () => {
            const execFileP = promisify(child_process.execFile);
            await expect(
                runBlocked(async () => {
                    await execFileP('node', ['-e', 'console.log("hi")']);
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
        });

        // exec and execFile are guarded by the same guardSubprocessWithPromisifyCustom maker but take different argument shapes (a shell command string vs. a file plus an args array) — covering exec too catches a fix that happens to work for one shape and silently breaks the other.
        test('Should resolve promisify(exec) to the real {stdout, stderr} shape and still block it inside runBlocked', async () => {
            const execP = promisify(child_process.exec);
            const result = await execP('node -e "console.log(\'hi\')"');
            expect(result).toEqual(
                expect.objectContaining({ stdout: expect.stringContaining('hi') }),
            );

            await expect(
                runBlocked(async () => {
                    await execP('node -e "console.log(\'hi\')"');
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
        });

        // Matches Node's real promisify(execFile) contract: a rejected error carries stdout/stderr too, not just a resolved success — a caller inspecting a failed command's captured output (e.g. this repo's own oss/apply.ts logging a failed `yarn licenses list`) needs it on the error path as much as the success path.
        test('Should attach stdout/stderr onto a rejected promisify(execFile) error, matching real Node behavior', async () => {
            const execFileP = promisify(child_process.execFile);
            await expect(
                execFileP('node', [
                    '-e',
                    'console.log("out"); console.error("boom"); process.exit(1)',
                ]),
            ).rejects.toEqual(
                expect.objectContaining({
                    stdout: expect.stringContaining('out'),
                    stderr: expect.stringContaining('boom'),
                }),
            );
        });

        // A dependency calling `new child_process.ChildProcess().spawn(...)` directly bypasses all the higher-level guarded factory functions above.
        test('Should block a direct new child_process.ChildProcess().spawn(...) call, bypassing the factory functions', async () => {
            await expect(
                runBlocked(async () => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (new child_process.ChildProcess() as any).spawn({ file: 'curl' });
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
        });

        // A worker gets a fresh V8 realm with its own module registry, so nothing inside it inherits
        // this file's monkeypatches — the only enforceable boundary is blocking construction itself.
        test('Should block new Worker(...) construction made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    new worker_threads.Worker('', { eval: true });
                }),
            ).rejects.toThrow(/Spawning a worker thread is not allowed/);
        });

        test('Should allow constructing, messaging, and cleanly terminating a Worker outside a blocked scope', async () => {
            const worker = new worker_threads.Worker(
                "require('worker_threads').parentPort.on('message', () => undefined);",
                { eval: true },
            );
            expect(worker).toBeInstanceOf(worker_threads.Worker);
            try {
                expect(() => worker.postMessage('ping')).not.toThrow();
            } finally {
                await expect(worker.terminate()).resolves.toEqual(expect.any(Number));
            }
        });

        // Guards against a per-cycle apply/restore swap: fn returning doesn't mean fn is done, since detached async work it scheduled without awaiting keeps running afterward and must still see the guard.
        test('Should still block a detached, unawaited setTimeout callback scheduled during fn, even after fn itself has already resolved', async () => {
            let detachedFetchResult: Promise<unknown> | undefined;
            let detachedFetchSettled = false;

            await runBlocked(async () => {
                // Deliberately not awaited — fn returns immediately while this keeps running in the background.
                setTimeout(() => {
                    const result = fetch('https://example.com');
                    detachedFetchResult = result;
                    // Attached synchronously so the rejection is never briefly unhandled before the `.rejects` assertion below attaches its own handler.
                    result.then(
                        () => {
                            detachedFetchSettled = true;
                        },
                        () => {
                            detachedFetchSettled = true;
                        },
                    );
                }, 0);
            });

            // fn (and therefore runBlocked) has already resolved here — a per-cycle restore would have put the real fetch back before this fires.
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(detachedFetchSettled).toBe(true);
            await expect(detachedFetchResult).rejects.toThrow(/Network access is not allowed/);
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

            // Confirms the guard doesn't leak a "still blocked" state the way a naive boolean (never reset on throw) could.
            const result = await runBlocked(async () => 'second execution result');
            expect(result).toBe('second execution result');
        });

        // The guarded property holds no snapshot to reinstall — its setter just updates the delegate — so an idle forceReset() has nothing to clobber.
        test('Should make an idle forceReset() a true no-op, never reinstalling an earlier mock over the current one', async () => {
            const originalFetch = globalThis.fetch;
            try {
                const mockA = jest.fn().mockResolvedValue('mock A');
                (globalThis as { fetch: typeof fetch }).fetch = mockA as unknown as typeof fetch;

                await runBlocked(async () => undefined);
                await expect(fetch('https://example.com')).resolves.toBe('mock A');

                // A later, unrelated mock is installed with runBlocked never called again in between, so the guard is genuinely idle.
                const mockB = jest.fn().mockResolvedValue('mock B');
                (globalThis as { fetch: typeof fetch }).fetch = mockB as unknown as typeof fetch;

                forceReset();

                await expect(fetch('https://example.com')).resolves.toBe('mock B');
            } finally {
                (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
            }
        });

        // Mirrors runScriptLocally's abandon-not-cancel model: an abandoned execution's late settlement must not restore real network access out from under a newer, still-active runBlocked scope.
        test("Should not let an abandoned runBlocked call's late restore corrupt a newer, currently-active runBlocked scope", async () => {
            let resolveAbandoned: (() => void) | undefined;
            const abandoned = runBlocked(
                () =>
                    new Promise<void>((resolve) => {
                        resolveAbandoned = resolve;
                    }),
            );

            // Simulates the timeout handler abandoning this execution, exactly like local-execution.ts's timer callback.
            forceReset();

            // A second, newer execution starts its own block scope; the fetch() check runs from inside its own fn's continuation to verify that customer code is still blocked.
            let openGate: (() => void) | undefined;
            const gate = new Promise<void>((resolve) => {
                openGate = resolve;
            });
            let currentFetchResult: Promise<unknown> | undefined;
            const current = runBlocked(async () => {
                await gate;
                currentFetchResult = fetch('https://example.com');
                await currentFetchResult.catch(() => undefined);
            });

            // The abandoned execution's fn() finally settles — its own finally block must not unblock the still-running newer scope.
            resolveAbandoned?.();
            await abandoned;

            openGate?.();
            await current;
            await expect(currentFetchResult).rejects.toThrow(/Network access is not allowed/);
        });

        // A caller can only ever read the guard through this property, never the true underlying
        // value, so the common "const original = x; x = mock; ...; x = original;" idiom hands the
        // guard itself back on restore. Confirms this round-trips to the real value it snapshotted
        // instead of the restored guard recursing into itself on the next unblocked call.
        test('Should not infinite-recurse when a caller restores a previously-read guard back onto a guarded property', async () => {
            const nativeStandIn = jest.fn().mockResolvedValue('native result');
            const originalFetch = globalThis.fetch;
            (globalThis as { fetch: typeof fetch }).fetch =
                nativeStandIn as unknown as typeof fetch;

            try {
                const capturedOriginal = globalThis.fetch;
                const mock = jest.fn().mockResolvedValue('mock result');
                (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

                await expect(fetch('https://example.com')).resolves.toBe('mock result');

                (globalThis as { fetch: typeof fetch }).fetch = capturedOriginal;

                await expect(fetch('https://example.com')).resolves.toBe('native result');
            } finally {
                (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
            }
        });

        // Since guardFetch is a process-wide singleton, code that never entered any runBlocked scope at all must not be wrongly blocked just because some other, unrelated runBlocked execution is active.
        test('Should not block a concurrent fetch() made from code that never entered any runBlocked scope', async () => {
            const fetchMock = jest.fn().mockResolvedValue('unrelated response');
            const originalFetch = globalThis.fetch;
            (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

            try {
                let resolveBlocked: (() => void) | undefined;
                const blocked = runBlocked(
                    () =>
                        new Promise<void>((resolve) => {
                            resolveBlocked = resolve;
                        }),
                );

                // Made from code entirely outside runBlocked/runAllowed, e.g. a concurrent cloud-mode request's own real fetch call.
                await expect(fetch('https://api.datadoghq.com/unrelated')).resolves.toBe(
                    'unrelated response',
                );

                resolveBlocked?.();
                await blocked;
            } finally {
                (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
            }
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

        test('Should keep two concurrent, legitimate $.Actions calls both allowed while they overlap, independently of each other', async () => {
            const fetchMock = jest.fn().mockResolvedValue('ok');
            const originalFetch = globalThis.fetch;
            (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
            const order: string[] = [];

            try {
                await runBlocked(async () => {
                    const first = runAllowed(async () => {
                        order.push('first-start');
                        await new Promise((r) => setTimeout(r, 20));
                        // Must still succeed even after `second` already finished — each call's exemption is scoped to its own async chain, not a shared depth counter.
                        await expect(fetch('https://first.example.com')).resolves.toBe('ok');
                        order.push('first-end');
                    });
                    const second = runAllowed(async () => {
                        order.push('second-start');
                        await expect(fetch('https://second.example.com')).resolves.toBe('ok');
                        order.push('second-end');
                    });

                    await second;
                    await first;
                });
            } finally {
                (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
            }

            expect(order).toEqual(['first-start', 'second-start', 'second-end', 'first-end']);
        });

        // A shared, process-wide "currently allowed" toggle would wrongly let this sibling fetch() through for the whole window an unrelated $.Actions call is in flight.
        test('Should keep a sibling raw fetch() call blocked while a concurrent, legitimate $.Actions call is in flight', async () => {
            const fetchMock = jest.fn().mockResolvedValue('real response');
            const originalFetch = globalThis.fetch;
            (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

            try {
                await runBlocked(async () => {
                    const allowedCall = runAllowed(async () => {
                        await new Promise((r) => setTimeout(r, 20));
                        return fetch('https://api.datadoghq.com');
                    });

                    // Made directly by "customer code", not through runAllowed, while allowedCall is still in flight.
                    await expect(fetch('https://example.com')).rejects.toThrow(
                        /Network access is not allowed/,
                    );

                    await expect(allowedCall).resolves.toBe('real response');
                });
            } finally {
                (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
            }
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

        // Mirrors an abandoned execution whose in-flight $.Actions call (inside runAllowed) settles late — that must not affect any execution that runs afterward.
        test("Should not let an abandoned runAllowed call's late settlement affect later executions", async () => {
            let resolveAbandonedAction: (() => void) | undefined;
            const abandonedAction = runAllowed(
                () =>
                    new Promise<void>((resolve) => {
                        resolveAbandonedAction = resolve;
                    }),
            );

            // Simulates the timeout handler abandoning this execution while the $.Actions call above is still in flight.
            forceReset();

            // A newer execution's own legitimate $.Actions call must be correctly allowed through and re-blocked afterward.
            const result = await runBlocked(async () => {
                await runAllowed(async () => 'newer allowed call');
                await expect(fetch('https://example.com')).rejects.toThrow(
                    /Network access is not allowed/,
                );
                return 'newer execution result';
            });
            expect(result).toBe('newer execution result');

            // The abandoned call finally settles, well after being superseded — it must not affect anything else.
            resolveAbandonedAction?.();
            await abandonedAction;

            // A further, unrelated later execution's own $.Actions call must still work.
            const laterResult = await runBlocked(async () =>
                runAllowed(async () => 'later allowed call'),
            );
            expect(laterResult).toBe('later allowed call');
        });

        // Stricter than the test above: here `runAllowed` is only called *after* `forceReset` already cleared the guard, so it must be a no-op rather than wedging the guard blocked afterward.
        test('Should treat a runAllowed call that only starts after its execution was already abandoned as a no-op, not a stale-but-matching generation', async () => {
            const fetchMock = jest.fn().mockResolvedValue('ok');
            const originalFetch = globalThis.fetch;
            (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

            try {
                forceReset();

                let resolveLateAction: (() => void) | undefined;
                const lateAction = runAllowed(
                    () =>
                        new Promise<void>((resolve) => {
                            resolveLateAction = resolve;
                        }),
                );
                resolveLateAction?.();
                await lateAction;

                // If the bug were present, the late call's finally would have left fetch permanently blocked even with nothing legitimate currently executing.
                await expect(fetch('https://example.com')).resolves.toBe('ok');

                // A real, later execution must still work normally afterward.
                const result = await runBlocked(async () => {
                    await runAllowed(async () => undefined);
                    await expect(fetch('https://example.com')).rejects.toThrow(
                        /Network access is not allowed/,
                    );
                    return 'later execution result';
                });
                expect(result).toBe('later execution result');
            } finally {
                (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
            }
        });
    });
});

describe('installGuardedProperty resilience', () => {
    // guardWebSocket returns undefined (not a guard function) when the real global WebSocket
    // doesn't exist — installGuardedProperty's buildGuard() must not pass that to WeakMap.set(),
    // which throws on a non-object key. Reproduced by deleting the global and freshly re-evaluating
    // this module's install-time guards (jest.isolateModules gives require() a clean module registry
    // for that call, independent of this file's own top-level import).
    test('Should not throw when installing the WebSocket guard on a Node version where global WebSocket does not exist', () => {
        const hadWebSocket = Object.prototype.hasOwnProperty.call(globalThis, 'WebSocket');
        const descriptor = hadWebSocket
            ? Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
            : undefined;
        delete (globalThis as { WebSocket?: unknown }).WebSocket;

        try {
            expect(() => {
                jest.isolateModules(() => {
                    // eslint-disable-next-line global-require -- must load fresh, after WebSocket is deleted, to re-run this module's install-time guards
                    require('./network-guard');
                });
            }).not.toThrow();
        } finally {
            if (descriptor) {
                Object.defineProperty(globalThis, 'WebSocket', descriptor);
            }
            forceReset();
        }
    });

    // Direct reassignment (`fetch = previous`) is handled by the WeakMap in installGuardedProperty,
    // but a wrapper closure over the previous guard is a distinct pattern some mocking libraries use
    // instead. Without a per-guard captured delegate, the previous guard's own getReal() would read
    // the same shared `real` variable the new guard just set to the wrapper -- calling back into the
    // wrapper and recursing until the stack overflows.
    test('Should not recurse when a guard is restored via a wrapper closure instead of direct reassignment', async () => {
        const originalFetch = globalThis.fetch;
        try {
            const realMock = jest.fn().mockResolvedValue('real result');
            (globalThis as { fetch: typeof fetch }).fetch = realMock as unknown as typeof fetch;
            const previous = globalThis.fetch;

            (globalThis as { fetch: typeof fetch }).fetch = ((...args: Parameters<typeof fetch>) =>
                previous(...args)) as typeof fetch;

            await expect(fetch('https://example.com')).resolves.toBe('real result');
        } finally {
            (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
        }
    });
});
