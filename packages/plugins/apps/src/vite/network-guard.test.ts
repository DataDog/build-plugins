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

import {
    forceReset,
    guardEventSource,
    guardWebSocket,
    guardWorker,
    installGuardedProperty,
    runAllowed,
    runBlocked,
    trustedFetch,
} from './network-guard';

// net/fetch/child_process are real process-wide singletons — a test that leaves them patched leaks into later tests in the same worker.
afterEach(() => {
    forceReset();
});

// Real server+socket pair for tests exercising state that only exists on a genuinely connected
// socket (e.g. keep-alive reuse) — connecting outside any blocked scope, since connect() itself is
// only guarded while blocked. Caller is responsible for closing the returned server.
async function createRealConnectedSocket(): Promise<{ server: net.Server; socket: net.Socket }> {
    const server = net.createServer((socket) => socket.on('data', () => undefined));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(port, 'localhost');
        s.once('connect', () => resolve(s));
        s.once('error', reject);
    });
    return { server, socket };
}

// `(globalThis as { fetch: typeof fetch }).fetch = impl` repeated verbatim at every mock/restore
// call site — this collapses the cast to one place.
function setGlobalFetch(impl: typeof fetch): void {
    (globalThis as { fetch: typeof fetch }).fetch = impl;
}

describe('network-guard', () => {
    describe('runBlocked', () => {
        test('Should block a raw net.Socket.connect() call made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    new net.Socket().connect(80, 'example.com');
                }),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should destroy (not throw synchronously) a net.Socket.write() call made inside fn, since a thrown write() surfaces as an uncaught exception inside code that calls it without a try/catch', async () => {
            await runBlocked(async () => {
                const socket = new net.Socket();
                const errorPromise = new Promise<Error>((resolve) => socket.once('error', resolve));
                expect(() => socket.write('data')).not.toThrow();
                const err = await errorPromise;
                expect(err.message).toMatch(/Network access is not allowed/);
            });
        });

        test('Should destroy (not throw synchronously) a net.Socket.end() call made inside fn, same reasoning as write() above', async () => {
            await runBlocked(async () => {
                const socket = new net.Socket();
                const errorPromise = new Promise<Error>((resolve) => socket.once('error', resolve));
                expect(() => socket.end('data')).not.toThrow();
                const err = await errorPromise;
                expect(err.message).toMatch(/Network access is not allowed/);
            });
        });

        // Destroying with no listener would hit Node's own default behavior for an unlistened
        // 'error' event — throwing and crashing the whole process — which a bare `socket.write(data)`
        // call with no error handling at all would trigger immediately.
        test('Should not crash the process when write()/end() is called inside fn on a socket with no error listener attached', async () => {
            await runBlocked(async () => {
                const socket = new net.Socket();
                expect(() => socket.write('data')).not.toThrow();
                expect(() => socket.end('data')).not.toThrow();
            });
            // If the guard had destroyed the socket with an unlistened error, the resulting
            // uncaught exception would already have crashed this Jest worker by now.
            await new Promise((resolve) => setImmediate(resolve));
        });

        // Regression test: a real socket always defers error emission at least a tick, so attaching
        // an 'error' listener on the line right after write()/end() is a safe, common pattern — the
        // guard's own listenerCount check must be deferred the same way, or it reads 0 listeners
        // synchronously (before this line runs) and silently swallows the blocked-write signal.
        test('Should still destroy the socket when the error listener is attached right after write()/end(), not just before', async () => {
            await runBlocked(async () => {
                const writeSocket = new net.Socket();
                expect(() => writeSocket.write('data')).not.toThrow();
                const writeErr = await new Promise<Error>((resolve) =>
                    writeSocket.once('error', resolve),
                );
                expect(writeErr.message).toMatch(/Network access is not allowed/);

                const endSocket = new net.Socket();
                expect(() => endSocket.end('data')).not.toThrow();
                const endErr = await new Promise<Error>((resolve) =>
                    endSocket.once('error', resolve),
                );
                expect(endErr.message).toMatch(/Network access is not allowed/);
            });
        });

        test('Should invoke a write() completion callback with the blocked error, instead of silently dropping it', async () => {
            await runBlocked(async () => {
                const socket = new net.Socket();
                socket.on('error', () => undefined);
                const err = await new Promise<Error | null | undefined>((resolve) =>
                    socket.write('data', (writeErr) => resolve(writeErr)),
                );
                expect(err?.message).toMatch(/Network access is not allowed/);
            });
        });

        // end()'s own callback type has no error parameter (unlike write()'s), so this only checks
        // invocation — the shared signalBlockedSocketOp still passes the error through at runtime,
        // exercised above for write().
        test('Should invoke an end() completion callback, instead of silently dropping it', async () => {
            await runBlocked(async () => {
                const socket = new net.Socket();
                socket.on('error', () => undefined);
                let called = false;
                await new Promise<void>((resolve) => {
                    socket.end('data', () => {
                        called = true;
                        resolve();
                    });
                });
                expect(called).toBe(true);
            });
        });

        test('Should block a fetch() call made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    await fetch('https://example.com');
                }),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        // dgram.send()'s real Node contract reports failure via an error-first callback (confirmed
        // via @types/node doc examples), never a synchronous throw — the guard must match that.
        test('Should block dgram.Socket.send() made inside fn via its error-first callback, not a synchronous throw', async () => {
            await runBlocked(async () => {
                const socket = dgram.createSocket('udp4');
                const err = await new Promise<Error>((resolve) => {
                    expect(() =>
                        socket.send('data', 80, 'example.com', (sendErr) =>
                            resolve(sendErr as Error),
                        ),
                    ).not.toThrow();
                });
                expect(err.message).toMatch(/Network access is not allowed/);
            });
        });

        // dgram.Socket.connect()'s callback is a success-only 'connect' event shorthand (confirmed
        // via @types/node: `callback?: () => void`) — real failures are only ever reported via the
        // async 'error' event, so the guard must signal that way too, not a synchronous throw.
        test("Should block dgram.Socket.connect() made inside fn via its async 'error' event, not a synchronous throw", async () => {
            await runBlocked(async () => {
                const socket = dgram.createSocket('udp4');
                const errorPromise = new Promise<Error>((resolve) => socket.once('error', resolve));
                expect(() => socket.connect(80, 'example.com')).not.toThrow();
                const err = await errorPromise;
                expect(err.message).toMatch(/Network access is not allowed/);
            });
        });

        // net.Server.listen()/dgram.Socket.bind()'s callback is a success-only 'listening' event
        // shorthand — a real bind failure returns synchronously and only reports EADDRINUSE via the
        // async 'error' event, so a synchronous throw here would surface as an uncaught exception in
        // the idiomatic `server.on('error', cb); server.listen(port);` pattern, which relies
        // entirely on that event.
        test("Should block net.Server.listen() and dgram.Socket.bind() made inside fn via the async 'error' event, not a synchronous throw", async () => {
            await runBlocked(async () => {
                const server = net.createServer();
                const errorPromise = new Promise<Error>((resolve) => server.once('error', resolve));
                expect(() => server.listen(0)).not.toThrow();
                const err = await errorPromise;
                expect(err.message).toMatch(/Network access is not allowed/);
            });

            await runBlocked(async () => {
                const socket = dgram.createSocket('udp4');
                const errorPromise = new Promise<Error>((resolve) => socket.once('error', resolve));
                expect(() => socket.bind(0)).not.toThrow();
                const err = await errorPromise;
                expect(err.message).toMatch(/Network access is not allowed/);
            });
        });

        // Regression test: a caller attaching the 'error' listener right after listen()/bind(),
        // rather than before, is a safe, idiomatic pattern against a real bind failure (which always
        // reports asynchronously) — the guard's own listener check must be deferred the same way
        // signalBlockedSocketOp's write()/end() check is, or it reads 0 listeners synchronously and
        // silently swallows the blocked-listen signal.
        test('Should still signal a blocked listen()/bind() when the error listener is attached right after, not just before', async () => {
            await runBlocked(async () => {
                const server = net.createServer();
                expect(() => server.listen(0)).not.toThrow();
                const err = await new Promise<Error>((resolve) => server.once('error', resolve));
                expect(err.message).toMatch(/Network access is not allowed/);
            });
        });

        test('Should not crash the process when listen()/bind() is blocked with no error listener attached', async () => {
            await runBlocked(async () => {
                const server = net.createServer();
                expect(() => server.listen(0)).not.toThrow();
                const socket = dgram.createSocket('udp4');
                expect(() => socket.bind(0)).not.toThrow();
            });
            // If the guard had emitted an unlistened 'error', the resulting uncaught exception would
            // already have crashed this Jest worker by now.
            await new Promise((resolve) => setImmediate(resolve));
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

        // Each of the 4 dns resolver surfaces is a distinct function object needing its own guard —
        // see network-guard.ts's DNS_RESOLVE_METHODS comment for why dns.lookup stays unguarded.
        describe('dns resolver methods', () => {
            // dns.resolve4's callback-style surfaces (plain and Resolver) report failure via their
            // mandatory error-first callback, never a synchronous throw — the promise-returning
            // surfaces (dns.promises.*) still correctly reject, unaffected by this.
            test('Should block dns.resolve4 on all 4 surfaces (plain, promises, Resolver, promises.Resolver) inside fn', async () => {
                await runBlocked(async () => {
                    const err = await new Promise<Error>((resolve) => {
                        expect(() =>
                            dns.resolve4('example.com', (resolveErr) =>
                                resolve(resolveErr as Error),
                            ),
                        ).not.toThrow();
                    });
                    expect(err.message).toMatch(/Network access is not allowed/);
                });

                await expect(
                    runBlocked(async () => {
                        await dns.promises.resolve4('example.com');
                    }),
                ).rejects.toThrow(/Network access is not allowed/);

                await runBlocked(async () => {
                    const err = await new Promise<Error>((resolve) => {
                        expect(() =>
                            new dns.Resolver().resolve4('example.com', (resolveErr) =>
                                resolve(resolveErr as Error),
                            ),
                        ).not.toThrow();
                    });
                    expect(err.message).toMatch(/Network access is not allowed/);
                });

                await expect(
                    runBlocked(async () => {
                        await new dns.promises.Resolver().resolve4('example.com');
                    }),
                ).rejects.toThrow(/Network access is not allowed/);
            });

            test('Should block dns.resolveTxt made inside fn via its error-first callback, not a synchronous throw', async () => {
                await runBlocked(async () => {
                    const err = await new Promise<Error>((resolve) => {
                        expect(() =>
                            dns.resolveTxt('example.com', (resolveErr) =>
                                resolve(resolveErr as Error),
                            ),
                        ).not.toThrow();
                    });
                    expect(err.message).toMatch(/Network access is not allowed/);
                });
            });

            test('Should block dns.promises.reverse made inside fn', async () => {
                await expect(
                    runBlocked(async () => {
                        await dns.promises.reverse('127.0.0.1');
                    }),
                ).rejects.toThrow(/Network access is not allowed/);
            });

            // Matches guardFetch's contract: dns.promises.* always returns a Promise, so a blocked
            // call must reject it rather than throw synchronously.
            test('Should reject rather than throw synchronously from dns.promises.resolve4 and dns.promises.Resolver.prototype.resolve4 when blocked', async () => {
                await runBlocked(async () => {
                    // Only the returned Promise should reject — calling the method itself must not throw.
                    let plainCallResult: Promise<unknown> | undefined;
                    expect(() => {
                        plainCallResult = dns.promises.resolve4('example.com');
                    }).not.toThrow();
                    // Duck-typed, not `toBeInstanceOf(Promise)` — this file and its test file can be
                    // separate module evaluations under Jest's per-file isolation, so the returned
                    // value's `Promise` constructor may not be strictly `===` this test file's own.
                    expect(typeof plainCallResult?.then).toBe('function');
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
                    // Same cross-realm caveat as above — duck-type instead of `toBeInstanceOf(Error)`.
                    expect(typeof (caught as Error)?.message).toBe('string');
                    expect((caught as Error).message).toMatch(/Network access is not allowed/);

                    // Same contract on the Resolver-instance surface.
                    const resolver = new dns.promises.Resolver();
                    let resolverCallResult: Promise<unknown> | undefined;
                    expect(() => {
                        resolverCallResult = resolver.resolve4('example.com');
                    }).not.toThrow();
                    expect(typeof resolverCallResult?.then).toBe('function');
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

        // spawn()/fork() synthesize a brand-new ChildProcess and never throw synchronously in real
        // Node — failure is only ever reported via the returned object's async 'error' event, so
        // the guard returns a stub shaped like the real return value instead of throwing.
        test("Should block child_process.spawn() and fork() made inside fn via the async 'error' event on the returned stub, not a synchronous throw", async () => {
            await runBlocked(async () => {
                let child: ReturnType<typeof child_process.spawn> | undefined;
                expect(() => {
                    child = child_process.spawn('curl', ['https://example.com']);
                }).not.toThrow();
                const err = await new Promise<Error>((resolve) => child?.once('error', resolve));
                expect(err.message).toMatch(/Spawning a subprocess is not allowed/);
            });

            await runBlocked(async () => {
                let child: ReturnType<typeof child_process.fork> | undefined;
                expect(() => {
                    child = child_process.fork('./some-script.js');
                }).not.toThrow();
                const err = await new Promise<Error>((resolve) => child?.once('error', resolve));
                expect(err.message).toMatch(/Spawning a subprocess is not allowed/);
            });
        });

        // Real spawn()/fork() always populate stdout/stderr/stdin and (for fork()) send()/
        // disconnect(), even for a command that never actually runs — a caller commonly touches
        // these right after the call, before any 'error' event has had a chance to fire.
        test('Should let a blocked spawn()/fork() stub be used like a real ChildProcess without throwing', async () => {
            await runBlocked(async () => {
                const child = child_process.spawn('curl', ['https://example.com']);
                expect(() => child.stdout?.on('data', () => {})).not.toThrow();
                expect(() => child.stderr?.on('data', () => {})).not.toThrow();
                expect(() => child.stdin?.write('data')).not.toThrow();
                expect(child.kill()).toBe(false);
            });

            await runBlocked(async () => {
                const child = child_process.fork('./some-script.js');
                expect(() => child.disconnect()).not.toThrow();
                // send() with a callback: the callback receives the error, matching a real
                // disconnected channel's contract.
                const callbackErr = await new Promise<Error>((resolve) => {
                    expect(() =>
                        child.send({ hello: 'world' }, (err) => resolve(err as Error)),
                    ).not.toThrow();
                });
                expect(callbackErr.message).toBeTruthy();

                // send() with no callback: falls back to an 'error' event instead of silently
                // dropping the failure.
                const eventErr = await new Promise<Error>((resolve) => {
                    child.once('error', resolve);
                    expect(() => child.send({ hello: 'world' })).not.toThrow();
                });
                expect(eventErr.message).toBeTruthy();
            });
        });

        // spawnSync never throws in real Node either — it returns a SpawnSyncReturns-shaped object
        // with `.error` set, so the guard mirrors that shape instead of throwing. `output` is `null`
        // on a real launch failure (not an array), and `stdout`/`stderr` are `undefined` — a caller
        // checking `if (result.output) { result.output[1].toString() }` would TypeError against a
        // truthy-but-empty array.
        test('Should block child_process.spawnSync() made inside fn via a SpawnSyncReturns-shaped `.error` matching real Node exactly, not a synchronous throw', async () => {
            await runBlocked(async () => {
                let result: ReturnType<typeof child_process.spawnSync> | undefined;
                expect(() => {
                    result = child_process.spawnSync('curl', ['https://example.com']);
                }).not.toThrow();
                expect(result?.error?.message).toMatch(/Spawning a subprocess is not allowed/);
                expect(result?.output).toBeNull();
                expect(result?.stdout).toBeUndefined();
                expect(result?.stderr).toBeUndefined();
                expect(result?.status).toBeNull();
                expect(result?.signal).toBeNull();
            });
        });

        // exec/execFile report failure via an error-first callback in real Node, unlike execSync/
        // execFileSync below, which genuinely do throw synchronously. Real Node sets stdout/stderr
        // to empty strings (not undefined) even on a launch failure — a caller doing
        // `err.stderr.trim()` in its callback would TypeError against `undefined`.
        test('Should block child_process.exec() and execFile() made inside fn via their error-first callback, matching real Node exactly', async () => {
            await runBlocked(async () => {
                const [err, stdout, stderr] = await new Promise<[Error, unknown, unknown]>(
                    (resolve) => {
                        expect(() =>
                            child_process.exec('curl https://example.com', (execErr, out, errOut) =>
                                resolve([execErr as Error, out, errOut]),
                            ),
                        ).not.toThrow();
                    },
                );
                expect(err.message).toMatch(/Spawning a subprocess is not allowed/);
                expect(stdout).toBe('');
                expect(stderr).toBe('');
            });

            await runBlocked(async () => {
                const [err, stdout, stderr] = await new Promise<[Error, unknown, unknown]>(
                    (resolve) => {
                        expect(() =>
                            child_process.execFile(
                                'curl',
                                ['https://example.com'],
                                (execErr, out, errOut) => resolve([execErr as Error, out, errOut]),
                            ),
                        ).not.toThrow();
                    },
                );
                expect(err.message).toMatch(/Spawning a subprocess is not allowed/);
                expect(stdout).toBe('');
                expect(stderr).toBe('');
            });
        });

        test('Should not crash the process when exec()/execFile() is called with no callback', async () => {
            await runBlocked(async () => {
                expect(() => child_process.exec('curl https://example.com')).not.toThrow();
                expect(() => child_process.execFile('curl', ['https://example.com'])).not.toThrow();
            });
            // If the guard had emitted an unlistened 'error' on the discarded stub, the resulting
            // uncaught exception would already have crashed this Jest worker by now.
            await new Promise((resolve) => setImmediate(resolve));
        });

        test('Should block child_process.execSync() and execFileSync() made inside fn via a synchronous throw, matching their real contract', async () => {
            await expect(
                runBlocked(async () => {
                    child_process.execSync('curl https://example.com');
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
            await expect(
                runBlocked(async () => {
                    child_process.execFileSync('curl', ['https://example.com']);
                }),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
        });

        // promisify.custom lives on the specific function object, not inherited by a fresh wrapper — @dd/tools execute() depends on the real shape.
        test('Should resolve promisify(execFile) to the real {stdout, stderr} shape, not a bare string, when not blocked', async () => {
            const execFileP = promisify(child_process.execFile);
            const result = await execFileP('node', ['-e', 'console.log("hi")']);
            expect(result).toEqual(
                expect.objectContaining({ stdout: expect.stringContaining('hi') }),
            );
        });

        test("Should still block promisify(execFile) inside a runBlocked scope, with stdout/stderr matching real Node's empty-string contract", async () => {
            const execFileP = promisify(child_process.execFile);
            await expect(
                runBlocked(async () => {
                    await execFileP('node', ['-e', 'console.log("hi")']);
                }),
            ).rejects.toMatchObject({
                message: expect.stringMatching(/Spawning a subprocess is not allowed/),
                stdout: '',
                stderr: '',
            });
        });

        // exec/execFile share a guard maker but take different argument shapes — a fix for one could silently miss the other.
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

        // Matches Node's real promisify(execFile) contract: a rejected error carries stdout/stderr too, not just a resolved success.
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

        // Matches Node's real PromiseWithChild contract — a caller outside a blocked scope that
        // inspects/signals/terminates `.child` must not lose it to this guard's own implementation.
        test("Should expose the spawned ChildProcess as `.child` on promisify(execFile)'s returned promise", async () => {
            const execFileP = promisify(child_process.execFile);
            const resultPromise = execFileP('node', ['-e', 'console.log("hi")']);
            expect(resultPromise.child).toBeInstanceOf(child_process.ChildProcess);
            await resultPromise;
        });

        test("Should expose the spawned ChildProcess as `.child` on promisify(exec)'s returned promise too", async () => {
            const execP = promisify(child_process.exec);
            const resultPromise = execP('node -e "console.log(\'hi\')"');
            expect(resultPromise.child).toBeInstanceOf(child_process.ChildProcess);
            await resultPromise;
        });

        // ChildProcess.prototype.spawn isn't in @types/node's public surface, so a locally-scoped
        // interface stands in for its real shape instead of an `any` escape hatch.
        interface ChildProcessWithSpawn {
            spawn(options: { file: string }): number;
            once(event: 'error', listener: (err: Error) => void): void;
        }

        // A dependency calling `new child_process.ChildProcess().spawn(...)` directly bypasses all
        // the higher-level guarded factory functions above. Unlike those, `this` is already the
        // real ChildProcess instance — spawn() itself never throws in real Node and returns a
        // synchronous integer, not undefined, so the guard emits 'error' on `this` and returns a
        // negative placeholder rather than fabricating a stub.
        test("Should block a direct new child_process.ChildProcess().spawn(...) call via the async 'error' event, bypassing the factory functions", async () => {
            await runBlocked(async () => {
                const child = new child_process.ChildProcess() as unknown as ChildProcessWithSpawn;
                let returnValue: number | undefined;
                expect(() => {
                    returnValue = child.spawn({ file: 'curl' });
                }).not.toThrow();
                expect(typeof returnValue).toBe('number');
                expect(returnValue).toBeLessThan(0);
                const err = await new Promise<Error>((resolve) => child.once('error', resolve));
                expect(err.message).toMatch(/Spawning a subprocess is not allowed/);
            });
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

        // fn returning doesn't mean fn is done — detached async work it scheduled without awaiting keeps running and must still see the guard.
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
                setGlobalFetch(mockA as unknown as typeof fetch);

                await runBlocked(async () => undefined);
                await expect(fetch('https://example.com')).resolves.toBe('mock A');

                // A later, unrelated mock is installed with runBlocked never called again in between, so the guard is genuinely idle.
                const mockB = jest.fn().mockResolvedValue('mock B');
                setGlobalFetch(mockB as unknown as typeof fetch);

                forceReset();

                await expect(fetch('https://example.com')).resolves.toBe('mock B');
            } finally {
                setGlobalFetch(originalFetch);
            }
        });

        // An abandoned execution's late settlement must not restore real network access out from under a newer, active runBlocked scope.
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

            // A second, newer execution starts its own scope; the fetch() check runs from inside its fn to verify customer code is still blocked.
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

        // The "const original = x; x = mock; x = original;" idiom hands the guard itself back on
        // restore — confirms this round-trips to the real value instead of recursing into itself.
        test('Should not infinite-recurse when a caller restores a previously-read guard back onto a guarded property', async () => {
            const nativeStandIn = jest.fn().mockResolvedValue('native result');
            const originalFetch = globalThis.fetch;
            setGlobalFetch(nativeStandIn as unknown as typeof fetch);

            try {
                const capturedOriginal = globalThis.fetch;
                const mock = jest.fn().mockResolvedValue('mock result');
                setGlobalFetch(mock as unknown as typeof fetch);

                await expect(fetch('https://example.com')).resolves.toBe('mock result');

                setGlobalFetch(capturedOriginal);

                await expect(fetch('https://example.com')).resolves.toBe('native result');
            } finally {
                setGlobalFetch(originalFetch);
            }
        });

        // guardFetch is a process-wide singleton — code that never entered any runBlocked scope must not be blocked by an unrelated one.
        test('Should not block a concurrent fetch() made from code that never entered any runBlocked scope', async () => {
            const fetchMock = jest.fn().mockResolvedValue('unrelated response');
            const originalFetch = globalThis.fetch;
            setGlobalFetch(fetchMock as unknown as typeof fetch);

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
                setGlobalFetch(originalFetch);
            }
        });
    });

    describe('runAllowed', () => {
        test('Should let a real network call through when nested inside runBlocked', async () => {
            const fetchMock = jest.fn().mockResolvedValue('real response');
            const originalFetch = globalThis.fetch;
            setGlobalFetch(fetchMock as unknown as typeof fetch);

            try {
                const result = await runBlocked(async () =>
                    runAllowed(async () => fetch('https://api.datadoghq.com')),
                );
                expect(result).toBe('real response');
                expect(fetchMock).toHaveBeenCalledWith('https://api.datadoghq.com');
            } finally {
                setGlobalFetch(originalFetch);
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
            setGlobalFetch(fetchMock as unknown as typeof fetch);
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
                setGlobalFetch(originalFetch);
            }

            expect(order).toEqual(['first-start', 'second-start', 'second-end', 'first-end']);
        });

        // A shared, process-wide "allowed" toggle would wrongly let this sibling fetch() through while an unrelated $.Actions call is in flight.
        test('Should keep a sibling raw fetch() call blocked while a concurrent, legitimate $.Actions call is in flight', async () => {
            const fetchMock = jest.fn().mockResolvedValue('real response');
            const originalFetch = globalThis.fetch;
            setGlobalFetch(fetchMock as unknown as typeof fetch);

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
                setGlobalFetch(originalFetch);
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

        // An abandoned execution's in-flight $.Actions call settling late must not affect any execution that runs afterward.
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

        // Stricter than the test above: runAllowed is called after forceReset already cleared the guard, so it must be a no-op.
        test('Should treat a runAllowed call that only starts after its execution was already abandoned as a no-op, not a stale-but-matching generation', async () => {
            const fetchMock = jest.fn().mockResolvedValue('ok');
            const originalFetch = globalThis.fetch;
            setGlobalFetch(fetchMock as unknown as typeof fetch);

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
                setGlobalFetch(originalFetch);
            }
        });

        // Regression test: forceReset()'s unconditional reset would have wrongly cleared a newer,
        // still-active scope here too — abandonIfCurrent() must only clear its own scope.
        test("Should not let an abandoned execution's own scope handle disturb a newer, still-active execution when abandoned late", async () => {
            let abandonedScopeHandle: { abandonIfCurrent: () => void } | undefined;
            let resolveAbandonedFn: (() => void) | undefined;
            const abandoned = runBlocked(
                () =>
                    new Promise<void>((resolve) => {
                        resolveAbandonedFn = resolve;
                    }),
                (handle) => {
                    abandonedScopeHandle = handle;
                },
            );

            // A newer execution starts before the abandoned one's timeout fires, taking over as the active scope.
            let resolveAllowedCall: ((value: string) => void) | undefined;
            const newerExecution = runBlocked(async () => {
                const allowedResult = await runAllowed(
                    () =>
                        new Promise<string>((resolve) => {
                            resolveAllowedCall = resolve;
                        }),
                );
                await expect(fetch('https://example.com')).rejects.toThrow(
                    /Network access is not allowed/,
                );
                return allowedResult;
            });

            // The abandoned execution's timeout fires here, after the newer scope has already taken over.
            abandonedScopeHandle?.abandonIfCurrent();

            resolveAllowedCall?.('newer allowed call, unaffected by the late abandon');
            await expect(newerExecution).resolves.toBe(
                'newer allowed call, unaffected by the late abandon',
            );

            resolveAbandonedFn?.();
            await abandoned;
        });
    });
});

describe('installGuardedProperty resilience', () => {
    // guardWebSocket returns undefined (not a guard function) when the global doesn't exist —
    // buildGuard() must not pass that to WeakMap.set(), which throws on a non-object key.
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

    // A wrapper closure over the previous guard (some mocking libraries' pattern, distinct from the
    // direct-reassignment case the WeakMap handles) would otherwise recurse into itself forever,
    // since its captured getReal() would read the shared `real` variable the new guard just set.
    test('Should not recurse when a guard is restored via a wrapper closure instead of direct reassignment', async () => {
        const originalFetch = globalThis.fetch;
        try {
            const realMock = jest.fn().mockResolvedValue('real result');
            setGlobalFetch(realMock as unknown as typeof fetch);
            const previous = globalThis.fetch;

            setGlobalFetch(((...args: Parameters<typeof fetch>) =>
                previous(...args)) as typeof fetch);

            await expect(fetch('https://example.com')).resolves.toBe('real result');
        } finally {
            setGlobalFetch(originalFetch);
        }
    });

    // CI pipes stdout/stderr into real net.Socket instances, so jest.spyOn(process.stderr, 'write')
    // elsewhere in this repo's test suite resolves `write` via our guarded net.Socket.prototype
    // accessor — jest-mock's own spyOn/mockRestore redefines the property using the descriptor it
    // found, so a non-configurable descriptor there makes Jest's own restore throw, unrelated to
    // any dependency this guard exists to stop.
    test("Should let Jest's own spyOn/mockRestore redefine a net.Socket instance's write() without throwing", () => {
        const socket = new net.Socket();
        const spy = jest.spyOn(socket, 'write').mockImplementation(() => true);
        expect(() => spy.mockRestore()).not.toThrow();
    });
});

describe('installGuardedProperty security', () => {
    // A dependency could otherwise call `Object.defineProperty(globalThis, 'fetch', {...})` directly
    // to replace the whole descriptor, silently restoring real network access — closed by installing
    // non-configurable outside of Jest. RUNNING_UNDER_JEST is computed once at module load, so a
    // fresh module instance with JEST_WORKER_ID unset is required to exercise that production branch.
    test('Should make a guarded property non-configurable outside of Jest, closing the Object.defineProperty bypass, while still allowing plain reassignment', () => {
        const originalJestWorkerId = process.env.JEST_WORKER_ID;
        delete process.env.JEST_WORKER_ID;

        try {
            // Definite assignment assertion: assigned synchronously inside jest.isolateModules below,
            // which TS's control-flow analysis doesn't see into.
            let freshInstallGuardedProperty!: typeof installGuardedProperty;
            jest.isolateModules(() => {
                // eslint-disable-next-line global-require -- must load fresh, with JEST_WORKER_ID unset, to exercise the non-Jest non-configurable branch
                freshInstallGuardedProperty = require('./network-guard').installGuardedProperty;
            });

            const target: { value: unknown } = { value: () => 'real' };
            freshInstallGuardedProperty(
                target,
                'value',
                (getReal: () => () => unknown) =>
                    (...args: unknown[]) =>
                        (getReal() as (...a: unknown[]) => unknown)(...args),
            );

            // A dependency replacing the whole descriptor outright must now fail loudly...
            expect(() => {
                Object.defineProperty(target, 'value', {
                    configurable: true,
                    enumerable: true,
                    value: () => 'hostile replacement',
                });
            }).toThrow(/Cannot redefine property/);

            // ...while the legitimate "capture original, mock, restore" idiom still works via plain assignment.
            const mock = () => 'mocked';
            (target as { value: unknown }).value = mock;
            expect((target.value as () => string)()).toBe('mocked');
        } finally {
            if (originalJestWorkerId !== undefined) {
                process.env.JEST_WORKER_ID = originalJestWorkerId;
            }
        }
    });

    // Guarding net.Socket.prototype directly (one property, shared by every socket) means a plain
    // `someSocket.write = mock` — an ordinary instance-level reassignment, not a hostile bypass —
    // must shadow the guard for that instance only, not repoint the one delegate every other
    // socket's guard still calls through.
    test('Should shadow a guarded property per-instance instead of corrupting the shared delegate when installed on a shared prototype', () => {
        const proto: { value: unknown } = { value: () => 'real' };
        installGuardedProperty(
            proto,
            'value',
            (getReal: () => () => unknown) =>
                (...args: unknown[]) =>
                    (getReal() as (...a: unknown[]) => unknown)(...args),
        );

        const instanceA = Object.create(proto) as { value: unknown };
        const instanceB = Object.create(proto) as { value: unknown };

        instanceA.value = () => 'mocked';

        expect((instanceA.value as () => string)()).toBe('mocked');
        expect((instanceB.value as () => string)()).toBe('real');
        expect((proto.value as () => string)()).toBe('real');
    });

    // Matches dns.resolveTlsa on Node 20: wrapping a method absent on this runtime would make
    // feature-detection lie, then crash the moment a library actually calls it.
    test('Should skip installing a guard entirely when the target property does not exist on this runtime', () => {
        const target: Record<string, unknown> = {};
        installGuardedProperty(target, 'doesNotExist', () => () => 'guard');
        expect(Object.prototype.hasOwnProperty.call(target, 'doesNotExist')).toBe(false);
    });

    // isCurrentlyBlocked() is the shared gate for every guard in this file — a fake AsyncLocalStorage
    // swapped in here (via a plain `net[symbol] = ...` assignment, which any code holding a `net`
    // reference could do) would silently disable all of them at once, not just one API surface.
    test('Should protect the AsyncLocalStorage registry entries stashed on `net` from being overwritten by any code holding a `net` reference', () => {
        const symbol = Symbol.for('@dd/apps-plugin/network-guard blockedContext');
        const registry = net as unknown as Record<symbol, unknown>;
        const descriptor = Object.getOwnPropertyDescriptor(registry, symbol);
        expect(descriptor).toMatchObject({ writable: false, configurable: false });

        expect(() => {
            Object.defineProperty(registry, symbol, {
                configurable: true,
                value: { getStore: () => undefined, run: (_v: unknown, fn: () => unknown) => fn() },
            });
        }).toThrow(/Cannot redefine property/);
    });
});

describe('guardEventSource and guardWorker', () => {
    // Global EventSource requires --experimental-eventsource on this repo's Node versions, so this
    // exercises guardEventSource directly against a fake constructor, not through the real global.
    test('Should block construction inside runBlocked and allow it outside', async () => {
        class FakeEventSource {
            url: string;
            constructor(url: string) {
                this.url = url;
            }
        }
        const Guarded = guardEventSource(() => FakeEventSource) as new (url: string) => unknown;

        await expect(
            runBlocked(async () => {
                new Guarded('http://example.com');
            }),
        ).rejects.toThrow(/Network access is not allowed/);

        expect(() => new Guarded('http://example.com')).not.toThrow();
    });

    test('Should return undefined when the real EventSource does not exist on this runtime', () => {
        expect(guardEventSource(() => undefined)).toBeUndefined();
    });

    // A later reassignment of worker_threads.Worker to undefined (e.g. the same "capture original,
    // mock, restore" idiom exercised elsewhere in this file, with a mock value of undefined) must
    // degrade gracefully instead of crashing installGuardedProperty's setter with `new Proxy(undefined, {})`.
    test('Should return undefined when the real Worker does not exist on this runtime', () => {
        expect(guardWorker(() => undefined)).toBeUndefined();
    });
});

describe('construct-trap newTarget forwarding', () => {
    // Discarding newTarget would make `class Foo extends WebSocket/Worker {}` silently produce a
    // base instance instead — exercised against fake constructors to avoid real construction side effects.
    test('guardWebSocket should forward newTarget so a subclass produces an instance of that subclass', () => {
        class FakeWebSocket {
            url: string;
            constructor(url: string) {
                this.url = url;
            }
        }
        const Guarded = guardWebSocket(() => FakeWebSocket) as new (url: string) => object;
        class CustomWebSocket extends Guarded {}

        const instance = new CustomWebSocket('ws://example.com');
        expect(instance).toBeInstanceOf(CustomWebSocket);
    });

    test('guardWorker should forward newTarget so a subclass produces an instance of that subclass', () => {
        class FakeWorker {
            options: unknown;
            constructor(options: unknown) {
                this.options = options;
            }
        }
        const Guarded = guardWorker(
            () => FakeWorker as unknown as typeof worker_threads.Worker,
        ) as unknown as new (options: unknown) => object;
        class CustomWorker extends Guarded {}

        const instance = new CustomWorker({});
        expect(instance).toBeInstanceOf(CustomWorker);
    });
});

describe('keep-alive connection reuse', () => {
    // A reused keep-alive socket (e.g. Node's default http.globalAgent) never calls
    // net.Socket.connect() again for a second request to the same host — connecting outside a
    // blocked scope and only writing inside one, as below, reproduces exactly what a real
    // keep-alive reuse looks like from the guard's perspective, without needing a real HTTP
    // round-trip (which this repo's Jest setup blocks via Nock's disabled net connect).
    test('Should still block a write on a socket that was connected before the blocked scope started', async () => {
        const { server, socket } = await createRealConnectedSocket();

        try {
            await runBlocked(async () => {
                const errorPromise = new Promise<Error>((resolve) => socket.once('error', resolve));
                expect(() => socket.write('data')).not.toThrow();
                const err = await errorPromise;
                expect(err.message).toMatch(/Network access is not allowed/);
            });
        } finally {
            server.close();
        }
    });
});

describe('process stdio passthrough', () => {
    // Spies on the REAL process.stdout/stderr's own destroy(), rather than swapping in a
    // substitute object via Object.defineProperty(process, 'stdout', ...): under a full-suite
    // Jest run, reassigning process.stdout/stderr's identity proved unreliable (something else in
    // the Jest/worker environment reads a different reference than the one just assigned, causing
    // spurious failures), where spying on the real singletons — the same idiom this repo's own
    // rollupConfig.test.ts already uses for process.stderr — does not have that problem.
    // destroy() is signalBlockedSocketOp's one observable side effect once an 'error' listener is
    // attached (added here only as that discriminator, removed after), so its absence proves the
    // real implementation ran, not the guard's blocked stand-in — this only exercises the guard at
    // all when process.stdout/stderr happen to be real net.Sockets (piped), same precondition the
    // keep-alive connection reuse test above has for its own real-socket setup.
    test('Should let a customer function write to process.stdout/stderr during a blocked scope even when they are real net.Sockets', async () => {
        const noop = () => undefined;
        process.stdout.on('error', noop);
        process.stderr.on('error', noop);
        const destroyStdout = jest.spyOn(process.stdout, 'destroy');
        const destroyStderr = jest.spyOn(process.stderr, 'destroy');

        try {
            await runBlocked(async () => {
                expect(() =>
                    process.stdout.write('hello from a customer function\n'),
                ).not.toThrow();
                expect(() =>
                    process.stderr.write('warning from a customer function\n'),
                ).not.toThrow();
            });
            expect(destroyStdout).not.toHaveBeenCalled();
            expect(destroyStderr).not.toHaveBeenCalled();

            // A real network socket must still be blocked in the same scope — the carve-out is
            // scoped to the two stdio singletons, not a blanket exemption for every net.Socket.
            await runBlocked(async () => {
                const socket = new net.Socket();
                const errorPromise = new Promise<Error>((resolve) => socket.once('error', resolve));
                expect(() => socket.write('data')).not.toThrow();
                const err = await errorPromise;
                expect(err.message).toMatch(/Network access is not allowed/);
            });
        } finally {
            destroyStdout.mockRestore();
            destroyStderr.mockRestore();
            process.stdout.removeListener('error', noop);
            process.stderr.removeListener('error', noop);
        }
    });

    // Regression test: process.stdout/stderr are configurable, reassignable accessor properties —
    // a customer function reassigning process.stdout to an already-connected socket, then writing
    // to it, must not be exempted just because it's *currently* aliased by that property. The
    // exemption is checked against the identity captured once at module load (trustedStdout),
    // not the live getter, so a substituted object is still blocked like any other socket.
    test('Should still block a write on a socket the customer function assigns to process.stdout, not just the real one', async () => {
        const { server, socket: attackerSocket } = await createRealConnectedSocket();

        try {
            const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');

            try {
                await runBlocked(async () => {
                    Object.defineProperty(process, 'stdout', {
                        configurable: true,
                        value: attackerSocket,
                    });
                    const errorPromise = new Promise<Error>((resolve) =>
                        attackerSocket.once('error', resolve),
                    );
                    expect(() => process.stdout.write('exfiltrated data')).not.toThrow();
                    const err = await errorPromise;
                    expect(err.message).toMatch(/Network access is not allowed/);
                });
            } finally {
                if (originalStdout) {
                    Object.defineProperty(process, 'stdout', originalStdout);
                }
            }
        } finally {
            server.close();
        }
    });
});

describe('trustedFetch', () => {
    // Regression test: a customer function can reassign globalThis.fetch to an attacker-controlled
    // wrapper (e.g. to capture the dev server's authenticated request while inside runAllowed).
    // trustedFetch is captured once at module load, before any customer code can run, so it must
    // keep resolving to the real implementation regardless of later reassignment — mirroring
    // trustedStdout/trustedStderr's identity-capture guarantee above.
    test('Should stay immune to globalThis.fetch being reassigned after module load', () => {
        const attackerFetch = jest.fn().mockResolvedValue(new Response('stolen'));
        const originalFetch = globalThis.fetch;
        setGlobalFetch(attackerFetch as unknown as typeof fetch);

        try {
            expect(trustedFetch).not.toBe(attackerFetch);
            expect(trustedFetch).not.toBe(globalThis.fetch);
        } finally {
            setGlobalFetch(originalFetch);
        }
    });

    test('Should remain unaffected by runBlocked, unlike the guarded globalThis.fetch', async () => {
        const before = trustedFetch;
        await runBlocked(async () => {
            expect(trustedFetch).toBe(before);
        });
        expect(trustedFetch).toBe(before);
    });
});
