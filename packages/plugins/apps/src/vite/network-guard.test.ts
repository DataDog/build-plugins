// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import child_process from 'child_process';
import { buildSync } from 'esbuild';
import fs from 'fs';
import net from 'net';
import { once } from 'node:events';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import worker_threads from 'worker_threads';

import { makeProbeDirOutsideTmp } from './network-guard.fixtures';
import {
    ALREADY_GUARDED,
    exemptFetchFromBlockedScope,
    exemptPluginContainerFromBlockedScope,
    FOREIGN_GUARD_MESSAGE,
    FS_WRITE_BLOCKED_MESSAGE,
    getSharedContext,
    gracefulFsPredatesGuards,
    guardWorker,
    installGuardedProperty,
    installGuards,
    networkGuardSymbol,
    NON_STRING_MODULE_ID_MESSAGE,
    runBlocked,
} from './network-guard';

beforeAll(() => {
    installGuards();
});

// Per-run directory, so leftover probe files from a regressed guard can't collide across runs or workers.
let probeDir: string;
beforeAll(() => {
    probeDir = makeProbeDirOutsideTmp('dd-network-guard-probes-');
});
afterAll(() => {
    rmSync(probeDir);
});

// The OS temp dir is the one place a run may write; a fresh subdirectory per test keeps runs apart.
let tmpWorkDir: string;
beforeEach(() => {
    const workPrefix = path.join(os.tmpdir(), 'dd-network-guard-work-');
    tmpWorkDir = fs.mkdtempSync(workPrefix);
});
afterEach(() => {
    rmSync(tmpWorkDir);
});

// `(globalThis as { fetch: typeof fetch }).fetch = impl` repeated verbatim at every mock/restore
// call site — this collapses the cast to one place.
function setGlobalFetch(impl: typeof fetch): void {
    (globalThis as { fetch: typeof fetch }).fetch = impl;
}

describe('network-guard', () => {
    describe('runBlocked', () => {
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
            const probePath = path.join(probeDir, 'detached.txt');
            let detachedWriteResult: Promise<unknown> | undefined;
            let detachedWriteSettled = false;

            await runBlocked(async () => {
                // Deliberately not awaited — fn returns immediately while this keeps running in the background.
                setTimeout(() => {
                    const result = fs.promises.writeFile(probePath, 'data');
                    detachedWriteResult = result;
                    // Attached synchronously so the rejection is never briefly unhandled before the `.rejects` assertion below attaches its own handler.
                    result.then(
                        () => {
                            detachedWriteSettled = true;
                        },
                        () => {
                            detachedWriteSettled = true;
                        },
                    );
                }, 0);
            });

            // fn (and therefore runBlocked) has already resolved here — a per-cycle restore would have put the real write method back before this fires.
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(detachedWriteSettled).toBe(true);
            await expect(detachedWriteResult).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
        });

        test('Should allow fs writes again after fn resolves', async () => {
            const probePath = path.join(probeDir, 'after-resolve.txt');
            await runBlocked(async () => undefined);
            fs.writeFileSync(probePath, 'written');
            const content = fs.readFileSync(probePath, 'utf8');
            fs.rmSync(probePath, { force: true });
            expect(content).toBe('written');
        });

        test('Should allow fs writes again even when fn throws', async () => {
            const probePath = path.join(probeDir, 'after-throw.txt');
            await expect(
                runBlocked(async () => {
                    throw new Error('customer function boom');
                }),
            ).rejects.toThrow('customer function boom');
            fs.writeFileSync(probePath, 'written');
            const content = fs.readFileSync(probePath, 'utf8');
            fs.rmSync(probePath, { force: true });
            expect(content).toBe('written');
        });

        test('Should not block a subsequent, separate runBlocked call after an earlier one already restored', async () => {
            await expect(
                runBlocked(async () => {
                    throw new Error('first execution boom');
                }),
            ).rejects.toThrow('first execution boom');

            // A naive boolean never reset on throw would leave writes blocked outside any scope.
            const result = await runBlocked(async () => 'second execution result');
            const probePath = path.join(probeDir, 'after-second.txt');
            fs.writeFileSync(probePath, 'written');
            const content = fs.readFileSync(probePath, 'utf8');
            expect(result).toBe('second execution result');
            expect(content).toBe('written');
        });

        // An abandoned execution's late settlement must not restore real fs access out from under a newer, active runBlocked scope.
        test("Should not let an abandoned runBlocked call's late restore corrupt a newer, currently-active runBlocked scope", async () => {
            const probePath = path.join(probeDir, 'abandoned.txt');
            let resolveAbandoned: (() => void) | undefined;
            const abandoned = runBlocked(
                () =>
                    new Promise<void>((resolve) => {
                        resolveAbandoned = resolve;
                    }),
            );

            // A second, newer execution starts its own scope; the write check runs from inside its fn to verify customer code is still blocked.
            let openGate: (() => void) | undefined;
            const gate = new Promise<void>((resolve) => {
                openGate = resolve;
            });
            let currentWriteResult: Promise<unknown> | undefined;
            const current = runBlocked(async () => {
                await gate;
                currentWriteResult = fs.promises.writeFile(probePath, 'data');
                await currentWriteResult.catch(() => undefined);
            });

            // The abandoned execution's fn() finally settles — its own finally block must not unblock the still-running newer scope.
            resolveAbandoned?.();
            await abandoned;

            openGate?.();
            await current;
            await expect(currentWriteResult).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
        });

        // The "const original = x; x = mock; x = original;" idiom hands the guard itself back on
        // restore — confirms this round-trips to the real value instead of recursing into itself.
        test('Should not infinite-recurse when a caller restores a previously-read guard back onto a guarded property', async () => {
            const nativeStandIn = jest.fn().mockReturnValue('native result');
            const originalWriteFileSync = fs.writeFileSync;
            Reflect.set(fs, 'writeFileSync', nativeStandIn);

            try {
                const capturedOriginal = fs.writeFileSync;
                const mock = jest.fn().mockReturnValue('mock result');
                Reflect.set(fs, 'writeFileSync', mock);

                const writeResult = fs.writeFileSync('probe.txt', 'data');
                expect(writeResult).toBe('mock result');

                Reflect.set(fs, 'writeFileSync', capturedOriginal);

                const writeResult2 = fs.writeFileSync('probe.txt', 'data');
                expect(writeResult2).toBe('native result');
            } finally {
                Reflect.set(fs, 'writeFileSync', originalWriteFileSync);
            }
        });

        // The guarded property is a process-wide singleton — code that never entered any runBlocked scope must not be blocked by an unrelated one.
        test('Should not block a concurrent fs.writeFileSync made from code that never entered any runBlocked scope', async () => {
            const writeFileSyncMock = jest.fn().mockReturnValue('unrelated result');
            const originalWriteFileSync = fs.writeFileSync;
            Reflect.set(fs, 'writeFileSync', writeFileSyncMock);

            try {
                let resolveBlocked: (() => void) | undefined;
                const blocked = runBlocked(
                    () =>
                        new Promise<void>((resolve) => {
                            resolveBlocked = resolve;
                        }),
                );

                // Made from code entirely outside runBlocked, e.g. a concurrent cloud-mode request's own real write call.
                const writeResult = fs.writeFileSync('unrelated.txt', 'data');
                expect(writeResult).toBe('unrelated result');

                resolveBlocked?.();
                await blocked;
            } finally {
                Reflect.set(fs, 'writeFileSync', originalWriteFileSync);
            }
        });
    });

    describe('fs write guard', () => {
        let tmpDir: string;
        let testFile: string;
        let nestedPrefix: string;

        beforeEach(() => {
            tmpDir = makeProbeDirOutsideTmp('dd-fs-guard-');
            testFile = path.join(tmpDir, 'test.txt');
            nestedPrefix = path.join(tmpDir, 'nested-');
        });

        afterEach(() => {
            rmSync(tmpDir);
        });

        // A non-UTF-8 byte decodes to U+FFFD, so the decoded path can differ from the one Node writes.
        test('Should refuse a Buffer path that does not decode losslessly', async () => {
            const tmpPath = path.join(tmpWorkDir, 'lossy-');
            const tmpPathBytes = Buffer.from(tmpPath);
            const invalidByte = Buffer.from([0xff]);
            const lossyPath = Buffer.concat([tmpPathBytes, invalidByte]);

            await expect(
                runBlocked(async () => {
                    fs.writeFileSync(lossyPath, 'data');
                }),
            ).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
        });

        test('Should allow a UTF-8 Buffer path under the temp dir', async () => {
            const tmpPath = path.join(tmpWorkDir, 'buffer-path.txt');
            const tmpPathBytes = Buffer.from(tmpPath);

            await runBlocked(async () => {
                fs.writeFileSync(tmpPathBytes, 'data');
            });
            const written = fs.readFileSync(tmpPath, 'utf8');

            expect(written).toBe('data');
        });

        test('Should block fs.writeFileSync made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    fs.writeFileSync(testFile, 'data');
                }),
            ).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
            const fileExists = fs.existsSync(testFile);
            expect(fileExists).toBe(false);
        });

        // unlink reports failure via its mandatory error-first callback, never a synchronous throw.
        test('Should block fs.unlink made inside fn via its error-first callback, not a synchronous throw', async () => {
            fs.writeFileSync(testFile, 'data');
            await runBlocked(async () => {
                const err = await new Promise<Error | null>((resolve) => {
                    expect(() =>
                        fs.unlink(testFile, (unlinkErr) => resolve(unlinkErr)),
                    ).not.toThrow();
                });
                expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
            });
            const fileExists = fs.existsSync(testFile);
            expect(fileExists).toBe(true);
        });

        // Real fs.unlink throws synchronously for a missing callback regardless of block state,
        // a caller bug that must surface rather than be silently swallowed.
        test('Should throw synchronously from fs.unlink made inside fn with no callback argument, with the same code as real fs', async () => {
            await expect(
                runBlocked(async () => {
                    Reflect.apply(fs.unlink, fs, [testFile]);
                }),
            ).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' });
        });

        test('Should reject rather than throw synchronously from fs.promises.writeFile when blocked', async () => {
            await runBlocked(async () => {
                const blockedWrite = fs.promises.writeFile(testFile, 'data');
                await expect(blockedWrite).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
            });
            const fileExists = fs.existsSync(testFile);
            expect(fileExists).toBe(false);
        });

        test('Should allow fs.writeFileSync outside a blocked scope', () => {
            expect(() => fs.writeFileSync(testFile, 'data')).not.toThrow();
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('data');
        });

        test('Should still allow fs.readFileSync inside a blocked scope, since only writes are guarded', async () => {
            fs.writeFileSync(testFile, 'data');
            await runBlocked(async () => {
                const content = fs.readFileSync(testFile, 'utf8');
                expect(content).toBe('data');
            });
        });

        // An fd opened for writing before the blocked scope started is still refused.
        test('Should block fs.writeSync made inside fn on an fd from openSync', async () => {
            const fd = fs.openSync(testFile, 'w');
            try {
                await expect(
                    runBlocked(async () => {
                        fs.writeSync(fd, 'data');
                    }),
                ).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
            } finally {
                fs.closeSync(fd);
            }
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('');
        });

        // Same openSync-then-fd-op bypass as writeSync above, but destroying existing content
        // instead of appending new content.
        test('Should block fs.ftruncateSync made inside fn on an fd from openSync', async () => {
            fs.writeFileSync(testFile, 'data');
            const fd = fs.openSync(testFile, 'r+');
            try {
                await expect(
                    runBlocked(async () => {
                        fs.ftruncateSync(fd, 0);
                    }),
                ).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
            } finally {
                fs.closeSync(fd);
            }
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('data');
        });

        test('Should block fs.write made inside fn via its error-first callback, not a synchronous throw', async () => {
            const fd = fs.openSync(testFile, 'w');
            try {
                await runBlocked(async () => {
                    const err = await new Promise<Error | null>((resolve) => {
                        expect(() =>
                            fs.write(fd, 'data', (writeErr) => resolve(writeErr)),
                        ).not.toThrow();
                    });
                    expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
                });
            } finally {
                fs.closeSync(fd);
            }
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('');
        });

        test('Should block fs.ftruncate made inside fn via its error-first callback, not a synchronous throw', async () => {
            fs.writeFileSync(testFile, 'data');
            const fd = fs.openSync(testFile, 'r+');
            try {
                await runBlocked(async () => {
                    const err = await new Promise<Error | null>((resolve) => {
                        expect(() =>
                            fs.ftruncate(fd, 0, (truncateErr) => resolve(truncateErr)),
                        ).not.toThrow();
                    });
                    expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
                });
            } finally {
                fs.closeSync(fd);
            }
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('data');
        });

        // mkdtemp creates a real directory, same class of write as mkdir — omitting it would let a
        // blocked function still create directories under the OS temp path.
        test('Should block fs.mkdtempSync made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    fs.mkdtempSync(nestedPrefix);
                }),
            ).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
            const entries = fs.readdirSync(tmpDir);
            expect(entries).toHaveLength(0);
        });

        test('Should block fs.mkdtemp made inside fn via its error-first callback, not a synchronous throw', async () => {
            await runBlocked(async () => {
                const err = await new Promise<Error | null>((resolve) => {
                    expect(() =>
                        fs.mkdtemp(nestedPrefix, (mkdtempErr) => resolve(mkdtempErr)),
                    ).not.toThrow();
                });
                expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
            });
            const entries = fs.readdirSync(tmpDir);
            expect(entries).toHaveLength(0);
        });

        test('Should reject rather than throw synchronously from fs.promises.mkdtemp when blocked', async () => {
            await runBlocked(async () => {
                await expect(fs.promises.mkdtemp(nestedPrefix)).rejects.toThrow(
                    FS_WRITE_BLOCKED_MESSAGE,
                );
            });
            const entries = fs.readdirSync(tmpDir);
            expect(entries).toHaveLength(0);
        });

        // fs.writeFile opens with 'w' (truncating) before its first write, so blocking only the write loses data.
        test('Should block fs.writeFile made inside fn without truncating the existing file', async () => {
            fs.writeFileSync(testFile, 'ORIGINAL');
            await runBlocked(async () => {
                const err = await new Promise<Error | null>((resolve) => {
                    fs.writeFile(testFile, 'replacement', resolve);
                });
                expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
            });
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('ORIGINAL');
        });

        test("Should block fs.createWriteStream made inside fn via the stream's error event, without truncating the existing file", async () => {
            fs.writeFileSync(testFile, 'ORIGINAL');
            await runBlocked(async () => {
                const stream = fs.createWriteStream(testFile);
                const err = await new Promise<Error | null>((resolve) => {
                    stream.once('error', resolve);
                });
                expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
            });
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('ORIGINAL');
        });

        test('Should block opening a file for writing inside fn via fs.open and fs.openSync', async () => {
            fs.writeFileSync(testFile, 'ORIGINAL');
            const numericWriteFlags = fs.constants.O_WRONLY + fs.constants.O_TRUNC;
            await runBlocked(async () => {
                expect(() => fs.openSync(testFile, 'w')).toThrow(FS_WRITE_BLOCKED_MESSAGE);
                expect(() => fs.openSync(testFile, numericWriteFlags)).toThrow(
                    FS_WRITE_BLOCKED_MESSAGE,
                );
                const err = await new Promise<Error | null>((resolve) => {
                    fs.open(testFile, 'r+', (openErr) => resolve(openErr));
                });
                expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
            });
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('ORIGINAL');
        });

        // Bit 31 makes the flag value negative, which the kernel ignores but a naive bit test misses.
        test('Should treat a negative numeric open flag as opening for writing', async () => {
            fs.writeFileSync(testFile, 'ORIGINAL');
            const signBitWriteFlags = -(2 ** 31) + fs.constants.O_WRONLY + fs.constants.O_TRUNC;
            await runBlocked(async () => {
                expect(() => fs.openSync(testFile, signBitWriteFlags)).toThrow(
                    FS_WRITE_BLOCKED_MESSAGE,
                );
            });
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('ORIGINAL');
        });

        test('Should block changing file permissions and ownership inside fn', async () => {
            fs.writeFileSync(testFile, 'data');
            const { uid, gid } = fs.statSync(testFile);
            await runBlocked(async () => {
                expect(() => fs.chmodSync(testFile, 0o600)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
                await expect(fs.promises.chown(testFile, uid, gid)).rejects.toThrow(
                    FS_WRITE_BLOCKED_MESSAGE,
                );
            });
        });

        // Matches a read-only filesystem, so dependencies that tolerate one degrade the same way.
        test("Should report a blocked fs write with code 'EROFS'", async () => {
            await expect(
                runBlocked(async () => {
                    fs.mkdirSync(nestedPrefix);
                }),
            ).rejects.toMatchObject({ code: 'EROFS' });
        });

        test('Should block changing file timestamps inside fn', async () => {
            fs.writeFileSync(testFile, 'data');
            await runBlocked(async () => {
                expect(() => fs.utimesSync(testFile, 0, 0)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
                await expect(fs.promises.utimes(testFile, 0, 0)).rejects.toThrow(
                    FS_WRITE_BLOCKED_MESSAGE,
                );
            });
            const { mtimeMs } = fs.statSync(testFile);
            expect(mtimeMs).toBeGreaterThan(0);
        });

        test('Should still allow opening a file read-only inside fn', async () => {
            fs.writeFileSync(testFile, 'data');
            await runBlocked(async () => {
                // No flags argument, so the callback sits where the flags normally go.
                const defaultFd = await new Promise<number>((resolve, reject) => {
                    fs.open(testFile, (openErr, fd) => (openErr ? reject(openErr) : resolve(fd)));
                });
                fs.closeSync(defaultFd);
                const handle = await fs.promises.open(testFile, 'r');
                await handle.close();
                const content = await new Promise<string>((resolve, reject) => {
                    fs.readFile(testFile, 'utf8', (readErr, data) =>
                        readErr ? reject(readErr) : resolve(data),
                    );
                });
                expect(content).toBe('data');
            });
        });

        // pino/sonic-boom log via fs.write(Sync) on fd 1/2, which isn't a filesystem write.
        test('Should let fs.writeSync and fs.write to stdout/stderr through inside fn', async () => {
            await runBlocked(async () => {
                const bytesWritten = fs.writeSync(1, '');
                expect(bytesWritten).toBe(0);
                const err = await new Promise<Error | null>((resolve) => {
                    fs.write(2, '', (writeErr) => resolve(writeErr));
                });
                expect(err).toBeNull();
            });
        });

        test.each([undefined, null, false])(
            'Should report a guarded fs method reassigned to %s as that value, so feature detection stays accurate',
            (stub) => {
                const originalCpSync = fs.cpSync;
                try {
                    Reflect.set(fs, 'cpSync', stub);
                    const reported: unknown = fs.cpSync;
                    expect(reported).toBe(stub);
                } finally {
                    Reflect.set(fs, 'cpSync', originalCpSync);
                }
            },
        );

        test('Should let fs.writeFileSync and fs.appendFileSync to stdout/stderr through inside fn', async () => {
            await runBlocked(async () => {
                expect(() => fs.writeFileSync(1, '')).not.toThrow();
                expect(() => fs.appendFileSync(2, '')).not.toThrow();
            });
        });

        test('Should block fs.copyFile made inside fn via its error-first callback, without creating the destination', async () => {
            fs.writeFileSync(testFile, 'data');
            const destination = path.join(tmpDir, 'copy.txt');
            await runBlocked(async () => {
                const err = await new Promise<Error | null>((resolve) => {
                    fs.copyFile(testFile, destination, resolve);
                });
                expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
            });
            const destinationExists = fs.existsSync(destination);
            expect(destinationExists).toBe(false);
        });

        test('Should block fs.writevSync made inside fn on an fd opened before the blocked scope', async () => {
            const fd = fs.openSync(testFile, 'w');
            const chunk = Buffer.from('data');
            try {
                await expect(
                    runBlocked(async () => {
                        fs.writevSync(fd, [chunk]);
                    }),
                ).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
            } finally {
                fs.closeSync(fd);
            }
            const content = fs.readFileSync(testFile, 'utf8');
            expect(content).toBe('');
        });

        test('Should refuse a write-mode fs.promises.open inside fn without truncating the file', async () => {
            fs.writeFileSync(testFile, 'ORIGINAL');
            const openError = await runBlocked(async () => {
                try {
                    const handle = await fs.promises.open(testFile, 'w');
                    await handle.close();
                    return undefined;
                } catch (err) {
                    return err;
                }
            });
            const content = fs.readFileSync(testFile, 'utf8');

            expect(openError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE, code: 'EROFS' });
            expect(content).toBe('ORIGINAL');
        });

        // Other packages' tests jest.spyOn(fs.promises, 'open') in the same Jest worker, which a
        // non-configurable accessor would break.
        test('Should keep the guarded fs.promises.open spy-able and restore it afterwards', () => {
            const guardedOpen = fs.promises.open;
            const spy = jest.spyOn(fs.promises, 'open');
            spy.mockRestore();
            const descriptor = Object.getOwnPropertyDescriptor(fs.promises, 'open');

            expect(descriptor?.get).toBeUndefined();
            expect(fs.promises.open).toBe(guardedOpen);
        });

        // A plain data property can be replaced outright, so each run re-wraps whatever is there.
        test('Should re-guard fs.promises.open after a reassignment that never calls the guard', async () => {
            fs.writeFileSync(testFile, 'ORIGINAL');
            const guardedOpen = fs.promises.open;
            const replacement = jest.fn(async () => 'replacement-handle');
            await runBlocked(async () => undefined);
            const stableWhileOurs = fs.promises.open === guardedOpen;
            Reflect.set(fs.promises, 'open', replacement);
            try {
                const openError = await runBlocked(async () => {
                    const opening = fs.promises.open(testFile, 'w');
                    return opening.then(
                        () => undefined,
                        (err: unknown) => err,
                    );
                });
                const outsideRun: unknown = await fs.promises.open(testFile, 'r');
                const content = fs.readFileSync(testFile, 'utf8');

                expect(stableWhileOurs).toBe(true);
                expect(openError).toMatchObject({
                    message: FS_WRITE_BLOCKED_MESSAGE,
                    code: 'EROFS',
                });
                expect(outsideRun).toBe('replacement-handle');
                expect(replacement).toHaveBeenCalledTimes(1);
                expect(content).toBe('ORIGINAL');
            } finally {
                Reflect.set(fs.promises, 'open', guardedOpen);
            }
        });

        test('Should keep a jest.spyOn of fs.promises.open guarded in a run and leave one guard once restored', async () => {
            const guardedOpen = fs.promises.open;
            const spy = jest.spyOn(fs.promises, 'open');
            try {
                const { refused, content } = await runBlocked(async () => {
                    const outsideOpen = fs.promises.open(testFile, 'w');
                    const settledOutside = outsideOpen.then(
                        () => undefined,
                        (err: unknown) => err,
                    );
                    const tmpFile = path.join(tmpWorkDir, 'spied.txt');
                    const handle = await fs.promises.open(tmpFile, 'w');
                    await fs.promises.writeFile(handle, 'spied');
                    await handle.close();
                    return {
                        refused: await settledOutside,
                        content: fs.readFileSync(tmpFile, 'utf8'),
                    };
                });

                expect(refused).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
                expect(content).toBe('spied');
                expect(spy).toHaveBeenCalled();
            } finally {
                spy.mockRestore();
            }
            expect(fs.promises.open).toBe(guardedOpen);
        });

        test('Should keep util.promisify(fs.write) resolving to its { bytesWritten, buffer } shape', async () => {
            const promisifiedWrite = promisify(fs.write);
            const fd = fs.openSync(testFile, 'w');
            try {
                const result = await promisifiedWrite(fd, 'abc');
                expect(result).toEqual({ bytesWritten: 3, buffer: 'abc' });
            } finally {
                fs.closeSync(fd);
            }
        });
    });
});

// For behavior only a separate process shows, like process exit or a real ESM import.
function buildGuardBundle(fileName: string): string {
    const bundlePath = path.join(probeDir, fileName);
    const guardSource = require.resolve('./network-guard');
    buildSync({
        entryPoints: [guardSource],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundlePath,
        logLevel: 'silent',
    });
    return bundlePath;
}

// Opens a temp-dir fd inside a run, closes it from outside the run, then writes to it from the run.
async function writeAfterClosingOutsideRun(run: typeof runBlocked): Promise<unknown> {
    let tmpFd = -1;
    let markOpened: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
        markOpened = resolve;
    });
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
    });
    const pendingRun = run(async () => {
        const tmpFile = path.join(tmpWorkDir, 'closed-elsewhere.txt');
        tmpFd = fs.openSync(tmpFile, 'w');
        markOpened?.();
        await runGate;
        try {
            fs.writeSync(tmpFd, 'data');
            return undefined;
        } catch (err) {
            return err;
        }
    });
    await opened;
    fs.closeSync(tmpFd);
    releaseRun?.();
    return pendingRun;
}

describe('temp dir writes', () => {
    test('Should return the real OS temp dir from os.tmpdir() inside a run', async () => {
        const outsideRun = os.tmpdir();
        const insideRun = await runBlocked(async () => os.tmpdir());

        expect(insideRun).toBe(outsideRun);
    });

    test('Should allow writes under the OS temp dir on every fs surface', async () => {
        const outsideSource = path.join(probeDir, 'copy-source.txt');
        fs.writeFileSync(outsideSource, 'source');
        const contents = await runBlocked(async () => {
            const dir = tmpWorkDir;
            const nested = path.join(dir, 'nested', 'deeper');
            fs.mkdirSync(nested, { recursive: true });
            const syncFile = path.join(nested, 'sync.txt');
            fs.writeFileSync(syncFile, 'sync');
            fs.appendFileSync(syncFile, '+appended');
            const promiseFile = path.join(dir, 'promise.txt');
            await fs.promises.writeFile(promiseFile, 'promise');
            const callbackFile = path.join(dir, 'callback.txt');
            await new Promise<void>((resolve, reject) => {
                fs.writeFile(callbackFile, 'callback', (err) => (err ? reject(err) : resolve()));
            });
            const streamFile = path.join(dir, 'stream.txt');
            await new Promise<void>((resolve, reject) => {
                const stream = fs.createWriteStream(streamFile);
                stream.on('error', reject);
                stream.end('stream', resolve);
            });
            const copiedFile = path.join(dir, 'copied.txt');
            fs.copyFileSync(outsideSource, copiedFile);
            const renamedFile = path.join(dir, 'renamed.txt');
            fs.renameSync(copiedFile, renamedFile);
            const fileNames = [syncFile, promiseFile, callbackFile, streamFile, renamedFile];
            return fileNames.map((name) => fs.readFileSync(name, 'utf8'));
        });

        expect(contents).toEqual(['sync+appended', 'promise', 'callback', 'stream', 'source']);
    });

    test('Should still block writes outside the OS temp dir, including a ../ escape out of it', async () => {
        const outsideFile = path.join(probeDir, 'outside-escape.txt');
        await runBlocked(async () => {
            const escapePath = path.join(tmpWorkDir, '..', '..', `dd-escape-${process.pid}.txt`);
            expect(() => fs.writeFileSync(outsideFile, 'data')).toThrow(FS_WRITE_BLOCKED_MESSAGE);
            expect(() => fs.writeFileSync(escapePath, 'data')).toThrow(FS_WRITE_BLOCKED_MESSAGE);
        });
        const outsideExists = fs.existsSync(outsideFile);
        expect(outsideExists).toBe(false);
    });

    test('Should block renaming or hardlinking files across the temp dir boundary', async () => {
        const outsideFile = path.join(probeDir, 'boundary.txt');
        fs.writeFileSync(outsideFile, 'ORIGINAL');
        await runBlocked(async () => {
            const inside = path.join(tmpWorkDir, 'inside.txt');
            fs.writeFileSync(inside, 'inside');
            const movedIn = path.join(tmpWorkDir, 'moved-in.txt');
            const linkedIn = path.join(tmpWorkDir, 'linked-in.txt');
            expect(() => fs.renameSync(outsideFile, movedIn)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
            expect(() => fs.renameSync(inside, outsideFile)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
            expect(() => fs.linkSync(outsideFile, linkedIn)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
        });
        const content = fs.readFileSync(outsideFile, 'utf8');
        expect(content).toBe('ORIGINAL');
    });

    // The temp dir can then never hold a link that redirects a write elsewhere.
    test('Should refuse creating symlinks, even inside the temp dir', async () => {
        const outsideFile = path.join(probeDir, 'symlink-target.txt');
        fs.writeFileSync(outsideFile, 'ORIGINAL');
        await runBlocked(async () => {
            const link = path.join(tmpWorkDir, 'link.txt');
            const promiseLink = path.join(tmpWorkDir, 'promise-link.txt');
            expect(() => fs.symlinkSync(outsideFile, link)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
            await expect(fs.promises.symlink(outsideFile, promiseLink)).rejects.toThrow(
                FS_WRITE_BLOCKED_MESSAGE,
            );
        });
        const content = fs.readFileSync(outsideFile, 'utf8');
        expect(content).toBe('ORIGINAL');
    });

    // cp copies symlinks as-is, which would put a link in the temp dir.
    test('Should refuse cp into the temp dir, while copyFile stays allowed', async () => {
        const sourceDir = path.join(probeDir, 'cp-source');
        fs.mkdirSync(sourceDir, { recursive: true });
        const sourceFile = path.join(sourceDir, 'file.txt');
        fs.writeFileSync(sourceFile, 'data');
        await runBlocked(async () => {
            const destination = path.join(tmpWorkDir, 'copied-dir');
            const copiedFile = path.join(tmpWorkDir, 'copied.txt');
            expect(() => fs.cpSync(sourceDir, destination, { recursive: true })).toThrow(
                FS_WRITE_BLOCKED_MESSAGE,
            );
            expect(() => fs.copyFileSync(sourceFile, copiedFile)).not.toThrow();
        });
    });

    // mkdtemp appends random characters to its prefix, so a prefix equal to the temp root lands beside it.
    test('Should refuse mkdtemp with the real OS temp dir itself as the prefix', async () => {
        const realTmpDir = fs.realpathSync(os.tmpdir());
        await runBlocked(async () => {
            const nestedPrefix = path.join(tmpWorkDir, 'nested-');
            expect(() => fs.mkdtempSync(realTmpDir)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
            expect(() => fs.mkdtempSync(nestedPrefix)).not.toThrow();
        });
    });

    test("Should allow mkdtemp with a temp subdirectory plus a trailing separator, Node's documented idiom", async () => {
        await runBlocked(async () => {
            const workDirWithSeparator = `${tmpWorkDir}${path.sep}`;
            expect(() => fs.mkdtempSync(workDirWithSeparator)).not.toThrow();
        });
    });

    // Only data writes count as console output; truncating or chmod-ing a redirected log does not.
    test('Should refuse non-write fd operations on stdout and stderr', async () => {
        await runBlocked(async () => {
            expect(() => fs.ftruncateSync(2, 0)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
            expect(() => fs.fchmodSync(1, 0o600)).toThrow(FS_WRITE_BLOCKED_MESSAGE);
        });
    });

    test('Should reject without running fn when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const fn = jest.fn(async () => 'ran');

        const run = runBlocked(fn, { signal: controller.signal });

        await expect(run).rejects.toThrow('aborted');
        expect(fn).not.toHaveBeenCalled();
    });

    test('Should refuse fd writes on a temp file descriptor once it has been closed', async () => {
        await runBlocked(async () => {
            const tmpFile = path.join(tmpWorkDir, 'closed-fd.txt');
            const fd = fs.openSync(tmpFile, 'w');
            fs.closeSync(fd);
            expect(() => fs.writeSync(fd, 'data')).toThrow(FS_WRITE_BLOCKED_MESSAGE);
        });
    });

    // Closing outside the run must still revoke the fd, or the OS's next file with that number
    // would inherit write access; an unrevoked fd fails with EBADF instead of the guard's error.
    test('Should forget a temp fd closed from outside the run', async () => {
        const closedElsewhereError = await writeAfterClosingOutsideRun(runBlocked);

        expect(closedElsewhereError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
    });

    test('Should forget a temp fd closed from outside a run started by another copy of the guard', async () => {
        let secondCopyRunBlocked: typeof runBlocked | undefined;
        jest.isolateModules(() => {
            ({ runBlocked: secondCopyRunBlocked } = require('./network-guard'));
        });
        if (!secondCopyRunBlocked) {
            throw new Error('The second copy of network-guard did not load.');
        }

        const closedElsewhereError = await writeAfterClosingOutsideRun(secondCopyRunBlocked);

        expect(closedElsewhereError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
    });

    // A timed-out execution is abandoned without cancelling fn, so runBlocked's own finally never runs.
    test("Should close the scope when the run is aborted, refusing fn's later path writes even if it never settles", async () => {
        const controller = new AbortController();
        const lateFile = path.join(tmpWorkDir, 'after-abort.txt');
        let lateWriteError: unknown;
        let lateWriteDone: (() => void) | undefined;
        const lateWriteFinished = new Promise<void>((resolve) => {
            lateWriteDone = resolve;
        });
        const hung = runBlocked(
            async () => {
                setTimeout(() => {
                    try {
                        fs.writeFileSync(lateFile, 'data');
                    } catch (err) {
                        lateWriteError = err;
                    }
                    lateWriteDone?.();
                }, 30);
                await new Promise<never>(() => {});
            },
            { signal: controller.signal },
        );
        hung.catch(() => undefined);
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });

        controller.abort();
        await lateWriteFinished;
        const written = fs.existsSync(lateFile);

        expect(lateWriteError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
        expect(written).toBe(false);
    });

    test('Should allow fd writes on a file opened in the temp dir, not on an fd opened outside it', async () => {
        const outsideFile = path.join(probeDir, 'outside-fd.txt');
        const outsideFd = fs.openSync(outsideFile, 'w');
        try {
            const tmpContent = await runBlocked(async () => {
                const tmpFile = path.join(tmpWorkDir, 'fd.txt');
                const tmpFd = fs.openSync(tmpFile, 'w');
                fs.writeSync(tmpFd, 'via fd');
                fs.closeSync(tmpFd);
                expect(() => fs.writeSync(outsideFd, 'data')).toThrow(FS_WRITE_BLOCKED_MESSAGE);
                return fs.readFileSync(tmpFile, 'utf8');
            });
            expect(tmpContent).toBe('via fd');
        } finally {
            fs.closeSync(outsideFd);
        }
        const outsideContent = fs.readFileSync(outsideFile, 'utf8');
        expect(outsideContent).toBe('');
    });

    // A detached callback keeps the run's async context, so its path writes stay refused.
    test('Should block path writes from a detached callback after the run ended, even under the OS temp dir', async () => {
        const lateFile = path.join(tmpWorkDir, 'detached.txt');
        let lateWriteError: unknown;
        let lateWriteDone: (() => void) | undefined;
        const lateWriteFinished = new Promise<void>((resolve) => {
            lateWriteDone = resolve;
        });
        await runBlocked(async () => {
            setTimeout(() => {
                try {
                    fs.writeFileSync(lateFile, 'data');
                } catch (err) {
                    lateWriteError = err;
                }
                lateWriteDone?.();
            }, 20);
        });
        await lateWriteFinished;
        const written = fs.existsSync(lateFile);

        expect(lateWriteError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
        expect(written).toBe(false);
    });

    test('Should let a FileHandle opened in the temp dir be written, but not one opened outside it', async () => {
        const outsideFile = path.join(probeDir, 'outside-handle.txt');
        const outsideHandle = await fs.promises.open(outsideFile, 'w');
        try {
            const { content, outsideError } = await runBlocked(async () => {
                const tmpFile = path.join(tmpWorkDir, 'handle.txt');
                const handle = await fs.promises.open(tmpFile, 'w');
                await fs.promises.writeFile(handle, 'via handle');
                await fs.promises.appendFile(handle, '+appended');
                await handle.close();
                const outsideWrite = fs.promises.writeFile(outsideHandle, 'data');
                const settled = await outsideWrite.then(
                    () => undefined,
                    (err: unknown) => err,
                );
                return { content: fs.readFileSync(tmpFile, 'utf8'), outsideError: settled };
            });

            expect(content).toBe('via handle+appended');
            expect(outsideError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
        } finally {
            await outsideHandle.close();
        }
        const outsideContent = fs.readFileSync(outsideFile, 'utf8');
        expect(outsideContent).toBe('');
    });
});

// A run can return before a stream it started has written, as plain Node allows.
describe('cold install', () => {
    // FileHandle's prototype is guarded from a handle the install opens asynchronously.
    test("Should refuse a FileHandle write in the first run, before the FileHandle guard's async install finished", () => {
        const bundlePath = buildGuardBundle('network-guard-cold-filehandle.bundle.cjs');
        const childTmpDir = path.join(probeDir, 'cold-filehandle-tmp');
        fs.mkdirSync(childTmpDir, { recursive: true });
        const outsideTmpFile = path.join(probeDir, 'cold-filehandle-target.txt');
        fs.writeFileSync(outsideTmpFile, 'data');
        const probeScript = [
            "const fs = require('fs');",
            'const guard = require(process.argv[1]);',
            "fs.promises.open(process.argv[2], 'r').then(async (handle) => {",
            '    const outcome = await guard',
            '        .runBlocked(() => handle.chmod(0o600))',
            "        .then(() => 'allowed', (err) => 'refused: ' + err.message);",
            '    console.log(outcome);',
            '    await handle.close();',
            '});',
        ].join('\n');

        const child = child_process.spawnSync(
            process.execPath,
            ['-e', probeScript, bundlePath, outsideTmpFile],
            { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: childTmpDir } },
        );

        expect(child.stderr).toBe('');
        expect(child.stdout).toBe(`refused: ${FS_WRITE_BLOCKED_MESSAGE}\n`);
    });
});

describe('late writes from a run that ended', () => {
    test('Should not crash when a run returns without waiting for a write stream it started', () => {
        const bundlePath = buildGuardBundle('network-guard-late-stream.bundle.cjs');
        const childTmpDir = path.join(probeDir, 'late-stream-tmp');
        fs.mkdirSync(childTmpDir, { recursive: true });
        const probeScript = [
            "const fs = require('fs');",
            "const os = require('os');",
            "const path = require('path');",
            'const guard = require(process.argv[1]);',
            'const startStream = async () => {',
            "    const tmpFile = path.join(os.tmpdir(), 'late.txt');",
            '    const stream = fs.createWriteStream(tmpFile);',
            "    stream.on('finish', () => console.log('finish'));",
            "    stream.end('data');",
            '    return 1;',
            '};',
            // The second run starts from a promise continuation, as the dev server's does.
            'guard',
            '    .runBlocked(startStream)',
            '    .then(() => new Promise((resolve) => setTimeout(resolve, 10)))',
            '    .then(() => guard.runBlocked(startStream));',
        ].join('\n');

        const child = child_process.spawnSync(process.execPath, ['-e', probeScript, bundlePath], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, TMPDIR: childTmpDir },
        });

        expect(child.stderr).toBe('');
        expect(child.status).toBe(0);
        expect(child.stdout).toBe('finish\nfinish\n');
    });

    test('Should let a stream opened in the run keep writing after the run ended', async () => {
        const lateData = 'late data';
        const stream = await runBlocked(async () => {
            const tmpFile = path.join(tmpWorkDir, 'late-write.txt');
            const tmpStream = fs.createWriteStream(tmpFile);
            await once(tmpStream, 'open');
            setTimeout(() => tmpStream.end(lateData), 50);
            return tmpStream;
        });
        const streamError = await new Promise<unknown>((resolve) => {
            stream.on('error', resolve);
            stream.on('close', () => resolve(undefined));
        });

        expect(streamError).toBeUndefined();
        expect(stream.bytesWritten).toBe(lateData.length);
    });

    // The OS hands a closed fd's number to the next open, here an unrelated file outside any run.
    test("Should revoke a run's fd closed after the run ended, so a reused fd number isn't writable", async () => {
        let releaseLateWrite: (() => void) | undefined;
        const lateWriteGate = new Promise<void>((resolve) => {
            releaseLateWrite = resolve;
        });
        let lateWrite: Promise<unknown> | undefined;
        const tmpFd = await runBlocked(async () => {
            const tmpFile = path.join(tmpWorkDir, 'reused.txt');
            const fd = fs.openSync(tmpFile, 'w');
            lateWrite = lateWriteGate.then(() => {
                try {
                    fs.writeSync(fd, 'late');
                    return undefined;
                } catch (err) {
                    return err;
                }
            });
            return fd;
        });
        fs.closeSync(tmpFd);
        const unrelatedFile = path.join(probeDir, 'reused-fd.txt');
        const unrelatedFd = fs.openSync(unrelatedFile, 'w');
        try {
            releaseLateWrite?.();
            const lateWriteError = await lateWrite;
            const content = fs.readFileSync(unrelatedFile, 'utf8');

            expect(unrelatedFd).toBe(tmpFd);
            expect(lateWriteError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
            expect(content).toBe('');
        } finally {
            fs.closeSync(unrelatedFd);
        }
    });

    test('Should refuse path writes from a run that ended, even while a stream it opened is still writing', async () => {
        let releaseLateWrite: (() => void) | undefined;
        const lateWriteGate = new Promise<void>((resolve) => {
            releaseLateWrite = resolve;
        });
        let lateWrite: Promise<unknown> | undefined;
        const lateFile = path.join(tmpWorkDir, 'late-path.txt');
        const stream = await runBlocked(async () => {
            const streamFile = path.join(tmpWorkDir, 'still-open.txt');
            const openStream = fs.createWriteStream(streamFile);
            await once(openStream, 'open');
            lateWrite = lateWriteGate.then(() => {
                try {
                    fs.writeFileSync(lateFile, 'data');
                    return undefined;
                } catch (err) {
                    return err;
                }
            });
            return openStream;
        });
        releaseLateWrite?.();
        const lateWriteError = await lateWrite;
        const written = fs.existsSync(lateFile);
        stream.end();
        await once(stream, 'close');

        expect(lateWriteError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
        expect(written).toBe(false);
    });

    // A FIFO's write-mode open blocks until a reader opens it, so it completes after the run ended.
    // The reader goes through a link outside the temp dir, so a regression can't hang the writer.
    test('Should record an fd whose open completes after the run ended, and revoke it once closed', async () => {
        const fifoPath = path.join(tmpWorkDir, 'fifo');
        child_process.execFileSync('mkfifo', [fifoPath]);
        const fifoLink = path.join(probeDir, 'fifo-link');
        fs.linkSync(fifoPath, fifoLink);
        let releaseLateWrite: (() => void) | undefined;
        const lateWriteGate = new Promise<void>((resolve) => {
            releaseLateWrite = resolve;
        });
        let lateOpen:
            | Promise<{ fd: number; writeError: unknown; lateWrite: Promise<unknown> }>
            | undefined;
        await runBlocked(async () => {
            lateOpen = new Promise((resolve, reject) => {
                fs.open(fifoPath, 'w', (openError, fd) => {
                    if (openError) {
                        reject(openError);
                        return;
                    }
                    let writeError: unknown;
                    try {
                        fs.writeSync(fd, 'x');
                    } catch (err) {
                        writeError = err;
                    }
                    const lateWrite = lateWriteGate.then(() => {
                        try {
                            fs.writeSync(fd, 'late');
                            return undefined;
                        } catch (err) {
                            return err;
                        }
                    });
                    resolve({ fd, writeError, lateWrite });
                });
            });
        });
        const readerFlags = fs.constants.O_RDONLY + fs.constants.O_NONBLOCK;
        const readerFd = fs.openSync(fifoLink, readerFlags);
        const unrelatedFile = path.join(probeDir, 'fifo-reused-fd.txt');
        try {
            const opened = await lateOpen;
            if (!opened) {
                throw new Error('The open never started.');
            }
            fs.closeSync(opened.fd);
            const unrelatedFd = fs.openSync(unrelatedFile, 'w');
            releaseLateWrite?.();
            const lateWriteError = await opened.lateWrite;
            fs.closeSync(unrelatedFd);
            const unrelatedContent = fs.readFileSync(unrelatedFile, 'utf8');

            expect(opened.writeError).toBeUndefined();
            expect(unrelatedFd).toBe(opened.fd);
            expect(lateWriteError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
            expect(unrelatedContent).toBe('');
        } finally {
            fs.closeSync(readerFd);
        }
    });
});

// tempy and temp-dir save the temp dir (temp-dir via fs.realpathSync) when they load, before any run.
function loadTempyLikeModule() {
    const savedTmpDir = os.tmpdir();
    const savedRealTmpDir = fs.realpathSync(savedTmpDir);
    return {
        temporaryPath: (name: string) => path.join(savedTmpDir, name),
        temporaryRealPath: (name: string) => path.join(savedRealTmpDir, name),
    };
}

describe('writes under the real OS temp directory', () => {
    test('Should let a library that saved the real temp dir at load write under it inside a run', async () => {
        const tempyLike = loadTempyLikeModule();
        const suffix = `${process.pid}-${Date.now()}`;
        const viaTmpdir = tempyLike.temporaryPath(`dd-tempy-like-${suffix}`);
        const viaRealPath = tempyLike.temporaryRealPath(`dd-temp-dir-like-${suffix}`);
        try {
            await runBlocked(async () => {
                const cacheDir = path.join(viaTmpdir, 'nested');
                fs.mkdirSync(cacheDir, { recursive: true });
                const cacheFile = path.join(cacheDir, 'cache.json');
                fs.writeFileSync(cacheFile, 'cached');
                await fs.promises.mkdir(viaRealPath);
                const realPathFile = path.join(viaRealPath, 'file.txt');
                await fs.promises.writeFile(realPathFile, 'real');
            });
            const cacheContent = fs.readFileSync(
                path.join(viaTmpdir, 'nested', 'cache.json'),
                'utf8',
            );
            const realPathContent = fs.readFileSync(path.join(viaRealPath, 'file.txt'), 'utf8');

            expect(cacheContent).toBe('cached');
            expect(realPathContent).toBe('real');
        } finally {
            rmSync(viaTmpdir);
            rmSync(viaRealPath);
        }
    });

    test('Should allow fd and FileHandle writes on files opened under the real temp dir', async () => {
        const tempyLike = loadTempyLikeModule();
        const suffix = `${process.pid}-${Date.now()}`;
        const fdFile = tempyLike.temporaryPath(`dd-fd-${suffix}.txt`);
        const handleFile = tempyLike.temporaryPath(`dd-handle-${suffix}.txt`);
        try {
            await runBlocked(async () => {
                const fd = fs.openSync(fdFile, 'w');
                fs.writeSync(fd, 'via fd');
                fs.closeSync(fd);
                const handle = await fs.promises.open(handleFile, 'w');
                await fs.promises.writeFile(handle, 'via handle');
                await handle.close();
            });
            const fdContent = fs.readFileSync(fdFile, 'utf8');
            const handleContent = fs.readFileSync(handleFile, 'utf8');

            expect(fdContent).toBe('via fd');
            expect(handleContent).toBe('via handle');
        } finally {
            rmSync(fdFile);
            rmSync(handleFile);
        }
    });

    test('Should refuse a write to a sibling of the real temp dir, including through a ../ escape', async () => {
        const realTmpDir = fs.realpathSync(os.tmpdir());
        const suffix = `${process.pid}-${Date.now()}`;
        const tmpParent = path.dirname(realTmpDir);
        const siblingPath = path.join(tmpParent, `dd-sibling-${suffix}.txt`);
        const escapePath = path.join(os.tmpdir(), '..', `dd-escape-${suffix}.txt`);
        const adjacentPath = `${realTmpDir}-dd-adjacent-${suffix}.txt`;
        const errors = await runBlocked(async () =>
            [siblingPath, escapePath, adjacentPath].map((target) => {
                try {
                    fs.writeFileSync(target, 'data');
                    return undefined;
                } catch (err) {
                    return err;
                }
            }),
        );
        const written = [siblingPath, escapePath, adjacentPath].filter((target) =>
            fs.existsSync(target),
        );

        expect(errors).toEqual([
            expect.objectContaining({ message: FS_WRITE_BLOCKED_MESSAGE }),
            expect.objectContaining({ message: FS_WRITE_BLOCKED_MESSAGE }),
            expect.objectContaining({ message: FS_WRITE_BLOCKED_MESSAGE }),
        ]);
        expect(written).toEqual([]);
    });

    test('Should refuse a write through a symlink in the real temp dir that points outside it', async () => {
        const linkPrefix = path.join(tmpWorkDir, 'dd-guard-links-');
        const linkDir = fs.mkdtempSync(linkPrefix);
        const outsideFile = path.join(probeDir, 'link-target.txt');
        fs.writeFileSync(outsideFile, 'ORIGINAL');
        const fileLink = path.join(linkDir, 'file-link.txt');
        const dirLink = path.join(linkDir, 'dir-link');
        fs.symlinkSync(outsideFile, fileLink);
        fs.symlinkSync(probeDir, dirLink);
        const throughDirLink = path.join(dirLink, 'created.txt');
        try {
            const errors = await runBlocked(async () =>
                [fileLink, throughDirLink].map((target) => {
                    try {
                        fs.writeFileSync(target, 'redirected');
                        return undefined;
                    } catch (err) {
                        return err;
                    }
                }),
            );
            const content = fs.readFileSync(outsideFile, 'utf8');
            const created = fs.existsSync(path.join(probeDir, 'created.txt'));

            expect(errors).toEqual([
                expect.objectContaining({ message: FS_WRITE_BLOCKED_MESSAGE }),
                expect.objectContaining({ message: FS_WRITE_BLOCKED_MESSAGE }),
            ]);
            expect(content).toBe('ORIGINAL');
            expect(created).toBe(false);
        } finally {
            rmSync(linkDir);
        }
    });

    // A library first loaded during a run saves os.tmpdir() then, so it must still work in later runs.
    test('Should let a temp-file library first loaded inside a run keep writing in a later run', async () => {
        let tempyLike: ReturnType<typeof loadTempyLikeModule> | undefined;
        const suffix = `${process.pid}-${Date.now()}`;
        const firstFile = await runBlocked(async () => {
            tempyLike = loadTempyLikeModule();
            const file = tempyLike.temporaryPath(`dd-lazy-first-${suffix}.txt`);
            fs.writeFileSync(file, 'first');
            return file;
        });
        if (!tempyLike) {
            throw new Error('The tempy-like module did not load.');
        }
        const loaded = tempyLike;
        try {
            const secondFile = await runBlocked(async () => {
                const file = loaded.temporaryPath(`dd-lazy-second-${suffix}.txt`);
                fs.writeFileSync(file, 'second');
                return file;
            });
            const contents = [firstFile, secondFile].map((file) => fs.readFileSync(file, 'utf8'));

            expect(contents).toEqual(['first', 'second']);
        } finally {
            const secondFile = loaded.temporaryPath(`dd-lazy-second-${suffix}.txt`);
            rmSync(firstFile);
            rmSync(secondFile);
        }
    });

    // unlink, rm and rename act on the entry itself, so a link outside the temp dir that points into it
    // must be judged by where the link lives, not where it points.
    test('Should refuse renaming over or unlinking a symlink outside the temp dir that points into it', async () => {
        const target = path.join(tmpWorkDir, 'link-target.txt');
        fs.writeFileSync(target, 'TARGET');
        const projectLink = path.join(probeDir, '.env-link');
        fs.symlinkSync(target, projectLink);
        const source = path.join(tmpWorkDir, 'source.txt');
        fs.writeFileSync(source, 'source');
        try {
            const errors = await runBlocked(async () =>
                [
                    () => fs.renameSync(source, projectLink),
                    () => fs.unlinkSync(projectLink),
                    () => fs.rmSync(projectLink),
                ].map((attempt) => {
                    try {
                        attempt();
                        return undefined;
                    } catch (err) {
                        return err;
                    }
                }),
            );
            const linkStat = fs.lstatSync(projectLink);
            const targetContent = fs.readFileSync(target, 'utf8');
            const refused = expect.objectContaining({ message: FS_WRITE_BLOCKED_MESSAGE });

            expect(errors).toEqual([refused, refused, refused]);
            expect(linkStat.isSymbolicLink()).toBe(true);
            expect(targetContent).toBe('TARGET');
        } finally {
            fs.unlinkSync(projectLink);
        }
    });

    // Node's recursive rm unlinks each entry through the guarded fs, including a link pointing outside.
    test('Should allow a recursive rm of a temp subdirectory that holds a symlink pointing outside it', async () => {
        const linkTarget = path.join(probeDir, 'rm-target');
        fs.mkdirSync(linkTarget, { recursive: true });
        const keptFile = path.join(linkTarget, 'kept.txt');
        fs.writeFileSync(keptFile, 'kept');
        const makeTree = (name: string) => {
            const tree = path.join(tmpWorkDir, name);
            fs.mkdirSync(tree);
            const nestedFile = path.join(tree, 'file.txt');
            fs.writeFileSync(nestedFile, 'data');
            const outwardLink = path.join(tree, 'outward');
            fs.symlinkSync(linkTarget, outwardLink);
            return tree;
        };
        const trees = ['sync-tree', 'callback-tree', 'promise-tree'].map(makeTree);
        await runBlocked(async () => {
            fs.rmSync(trees[0], { recursive: true });
            await new Promise<void>((resolve, reject) => {
                fs.rm(trees[1], { recursive: true }, (err) => (err ? reject(err) : resolve()));
            });
            await fs.promises.rm(trees[2], { recursive: true });
        });
        const remaining = trees.filter((tree) => fs.existsSync(tree));
        const keptContent = fs.readFileSync(keptFile, 'utf8');

        expect(remaining).toEqual([]);
        expect(keptContent).toBe('kept');
    });

    // fh.close() never reaches fs.close, so the guarded FileHandle close revokes the fd.
    test('Should allow fd writes on a write-mode FileHandle from the temp dir, and revoke its fd once closed', async () => {
        const handleFile = path.join(tmpWorkDir, 'handle-fd.txt');
        const { afterClose, content } = await runBlocked(async () => {
            const handle = await fs.promises.open(handleFile, 'w');
            const { fd } = handle;
            fs.writeSync(fd, 'via fd');
            fs.ftruncateSync(fd, 3);
            const stream = fs.createWriteStream('', { fd, autoClose: false, start: 3 });
            stream.end('+stream');
            await once(stream, 'finish');
            await handle.close();
            let lateError: unknown;
            try {
                fs.writeSync(fd, 'late');
            } catch (err) {
                lateError = err;
            }
            return { afterClose: lateError, content: fs.readFileSync(handleFile, 'utf8') };
        });

        expect(content).toBe('via+stream');
        expect(afterClose).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
    });

    // outputFile, mkdirp and make-dir first make sure the parent exists, which can be the temp root.
    test('Should let a run ensure the temp root exists before writing directly under it', async () => {
        const suffix = `${process.pid}-${Date.now()}`;
        const tmpRoot = os.tmpdir();
        const outputFile = path.join(tmpRoot, `dd-output-${suffix}.json`);
        try {
            await runBlocked(async () => {
                outputFileSync(outputFile, '{}');
                await fs.promises.mkdir(tmpRoot, { recursive: true });
                await new Promise<void>((resolve, reject) => {
                    fs.mkdir(tmpRoot, { recursive: true }, (err) =>
                        err ? reject(err) : resolve(),
                    );
                });
            });
            const content = fs.readFileSync(outputFile, 'utf8');

            expect(content).toBe('{}');
        } finally {
            rmSync(outputFile);
        }
    });

    // The kernel follows `link` before applying `..`, so `<link>/..` is the link target's parent.
    test('Should refuse writes through `<link>/..` when a link in the real temp dir points outside it', async () => {
        const linkPrefix = path.join(tmpWorkDir, 'dd-guard-dotdot-');
        const linkDir = fs.mkdtempSync(linkPrefix);
        const linkTarget = path.join(probeDir, 'dotdot-src');
        fs.mkdirSync(linkTarget, { recursive: true });
        const link = path.join(linkDir, 'proj');
        fs.symlinkSync(linkTarget, link);
        const source = path.join(linkDir, 'source.txt');
        fs.writeFileSync(source, 'data');
        const escape = [link, '..', 'dotdot-victim.txt'].join(path.sep);
        const victim = path.join(probeDir, 'dotdot-victim.txt');
        try {
            const errors = await runBlocked(async () =>
                [
                    () => fs.writeFileSync(escape, 'redirected'),
                    () => fs.copyFileSync(source, escape),
                    () => fs.renameSync(source, escape),
                    () => fs.linkSync(source, escape),
                    () => fs.openSync(escape, 'w'),
                ].map((attempt) => {
                    try {
                        attempt();
                        return undefined;
                    } catch (err) {
                        return err;
                    }
                }),
            );
            const victimCreated = fs.existsSync(victim);
            const refused = expect.objectContaining({ message: FS_WRITE_BLOCKED_MESSAGE });

            expect(errors).toEqual([refused, refused, refused, refused, refused]);
            expect(victimCreated).toBe(false);
        } finally {
            rmSync(linkDir);
        }
    });

    // Removing or renaming the temp root would break $TMPDIR for every process, so it runs against
    // a disposable TMPDIR in a child process.
    test('Should refuse removing, renaming or chmod-ing the real temp dir itself', () => {
        const bundlePath = buildGuardBundle('network-guard-tmp-root.bundle.cjs');
        const disposableTmp = path.join(probeDir, 'disposable-tmp');
        fs.mkdirSync(disposableTmp, { recursive: true });
        const probeScript = [
            "const fs = require('fs');",
            'const guard = require(process.argv[1]);',
            'const root = process.env.TMPDIR;',
            'const attempts = {',
            '    rm: () => fs.rmSync(root, { recursive: true, force: true }),',
            '    chmod: () => fs.chmodSync(root, 0o700),',
            "    rename: () => fs.renameSync(root, root + '-moved'),",
            '};',
            'guard.installGuards();',
            'guard.runBlocked(async () => Object.fromEntries(Object.entries(attempts).map(([name, attempt]) => {',
            '    try { attempt(); return [name, "done"]; } catch (err) { return [name, err.code]; }',
            '}))).then((codes) => console.log(JSON.stringify(codes)));',
        ].join('\n');

        const output = child_process.execFileSync(
            process.execPath,
            ['-e', probeScript, bundlePath],
            {
                encoding: 'utf8',
                env: { PATH: process.env.PATH, TMPDIR: disposableTmp },
            },
        );
        const codes: unknown = JSON.parse(output);
        const rootSurvived = fs.existsSync(disposableTmp);

        expect(codes).toEqual({ rm: 'EROFS', chmod: 'EROFS', rename: 'EROFS' });
        expect(rootSurvived).toBe(true);
    });

    // chmod, chown and utimes work on a read-mode handle, and a handle's own methods skip the fs guards.
    test("Should refuse a read-mode FileHandle's modifying methods inside a run, but allow a writable temp-dir handle's", async () => {
        const outsideFile = path.join(probeDir, 'read-handle.txt');
        fs.writeFileSync(outsideFile, 'data');
        fs.chmodSync(outsideFile, 0o644);
        const outcome = await runBlocked(async () => {
            const readHandle = await fs.promises.open(outsideFile, 'r');
            try {
                const settle = (attempt: Promise<void>) =>
                    attempt.then(
                        () => undefined,
                        (err: unknown) => err,
                    );
                const chmodError = await settle(readHandle.chmod(0o600));
                const utimesError = await settle(readHandle.utimes(0, 0));
                const tmpFile = path.join(tmpWorkDir, 'mode.txt');
                const writable = await fs.promises.open(tmpFile, 'w');
                await writable.chmod(0o600);
                await writable.close();
                const tmpMode = fs.statSync(tmpFile).mode.toString(8).slice(-3);
                return { chmodError, utimesError, tmpMode };
            } finally {
                await readHandle.close();
            }
        });
        const outsideMode = fs.statSync(outsideFile).mode.toString(8).slice(-3);
        const refused = expect.objectContaining({ message: FS_WRITE_BLOCKED_MESSAGE });

        expect(outcome).toEqual({ chmodError: refused, utimesError: refused, tmpMode: '600' });
        expect(outsideMode).toBe('644');
    });
});

// Every bundler that loads the plugin imports this file, so importing it must not patch anything.
describe('installGuards', () => {
    test('Should leave fs and child_process untouched on import, patching them only once installGuards runs', () => {
        const bundlePath = buildGuardBundle('network-guard.bundle.cjs');
        const probeScript = [
            "const fs = require('fs');",
            "const childProcess = require('child_process');",
            'const isGuarded = () => [',
            "    Object.getOwnPropertyDescriptor(fs, 'writeFileSync').get !== undefined,",
            "    Object.getOwnPropertyDescriptor(childProcess, 'spawn').get !== undefined,",
            '];',
            'const guard = require(process.argv[1]);',
            'const afterImport = isGuarded();',
            'guard.installGuards();',
            'const afterInstall = isGuarded();',
            'console.log(JSON.stringify({ afterImport, afterInstall }));',
        ].join('\n');

        const output = child_process.execFileSync(
            process.execPath,
            ['-e', probeScript, bundlePath],
            {
                encoding: 'utf8',
                env: { PATH: process.env.PATH },
            },
        );
        const result: unknown = JSON.parse(output);

        expect(result).toEqual({ afterImport: [false, false], afterInstall: [true, true] });
    });

    // A partial install must not leave later calls believing everything is installed.
    test('Should retry a failed install on the next call instead of silently skipping it', () => {
        const bundlePath = buildGuardBundle('network-guard-retry.bundle.cjs');
        const probeScript = [
            "const fs = require('fs');",
            "Object.defineProperty(fs, 'cpSync', { value: fs.cpSync, writable: false, configurable: false });",
            'const guard = require(process.argv[1]);',
            'const attempt = () => { try { guard.installGuards(); return "installed"; } catch { return "threw"; } };',
            'console.log(JSON.stringify([attempt(), attempt()]));',
        ].join('\n');

        const output = child_process.execFileSync(
            process.execPath,
            ['-e', probeScript, bundlePath],
            {
                encoding: 'utf8',
                env: { PATH: process.env.PATH },
            },
        );
        const attempts: unknown = JSON.parse(output);

        expect(attempts).toEqual(['threw', 'threw']);
    });

    // graceful-fs publishes this queue on the real fs when it loads, and its clone copies fs's functions.
    test.each([
        { marker: true, expected: true },
        { marker: false, expected: false },
    ])(
        'Should report whether graceful-fs patched fs before the guards installed (marker: $marker)',
        ({ marker, expected }) => {
            const bundlePath = buildGuardBundle('network-guard-graceful-marker.bundle.cjs');
            const probeScript = [
                "const fs = require('fs');",
                "if (process.argv[2] === 'true') Object.defineProperty(fs, Symbol.for('graceful-fs.queue'), { get: () => [] });",
                'const guard = require(process.argv[1]);',
                'guard.installGuards();',
                'console.log(JSON.stringify(guard.gracefulFsPredatesGuards()));',
            ].join('\n');

            const output = child_process.execFileSync(
                process.execPath,
                ['-e', probeScript, bundlePath, String(marker)],
                {
                    encoding: 'utf8',
                    env: { PATH: process.env.PATH },
                },
            );
            const predates: unknown = JSON.parse(output);

            expect(predates).toBe(expected);
            expect(gracefulFsPredatesGuards).toEqual(expect.any(Function));
        },
    );

    // The null-device handle that hands over FileHandle's prototype is closed at install, unawaited.
    test('Should not crash the process when closing the FileHandle it inspects at install rejects', () => {
        const bundlePath = buildGuardBundle('network-guard-close-rejects.bundle.cjs');
        // A handle's close is its own property, so the rejection is planted on each handle opened.
        const probeScript = [
            "const fs = require('fs');",
            'const realOpen = fs.promises.open;',
            'fs.promises.open = async (...args) => {',
            '    const handle = await realOpen(...args);',
            '    const realClose = handle.close;',
            "    handle.close = () => realClose.call(handle).then(() => { throw new Error('close failed'); });",
            '    return handle;',
            '};',
            'const guard = require(process.argv[1]);',
            'guard.installGuards();',
            "setTimeout(() => console.log('alive'), 100);",
        ].join('\n');

        const child = child_process.spawnSync(process.execPath, ['-e', probeScript, bundlePath], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH },
        });

        expect(child.stderr).toBe('');
        expect(child.status).toBe(0);
        expect(child.stdout).toBe('alive\n');
    });

    test("Should give an ESM named import of fs/promises' open the guarded version", () => {
        const bundlePath = buildGuardBundle('network-guard-esm.bundle.cjs');
        const target = path.join(probeDir, 'esm-open.txt');
        const probeScript = [
            "import { open } from 'node:fs/promises';",
            "import { createRequire } from 'node:module';",
            'const guard = createRequire(import.meta.url)(process.argv[1]);',
            'guard.installGuards();',
            'const opening = guard.runBlocked(() => open(process.argv[2], "w"));',
            'const code = await opening.then(() => "opened", (err) => err.code);',
            'console.log(code);',
        ].join('\n');

        const output = child_process.execFileSync(
            process.execPath,
            ['--input-type=module', '-e', probeScript, bundlePath, target],
            {
                encoding: 'utf8',
                env: { PATH: process.env.PATH },
            },
        );
        const code = output.trim();
        const created = fs.existsSync(target);

        expect(code).toBe('EROFS');
        expect(created).toBe(false);
    });
});

describe('mixed plugin versions', () => {
    // Another release's wrappers consult only that release's context, so a run here would be unguarded.
    test("Should refuse to run when another release's guard is already installed", async () => {
        let freshCopy: typeof import('./network-guard') | undefined;
        jest.isolateModules(() => {
            freshCopy = require('./network-guard');
        });
        if (!freshCopy) {
            throw new Error('The fresh copy of network-guard did not load.');
        }
        const foreignGetter = () => () => 'real';
        Object.defineProperty(foreignGetter, ALREADY_GUARDED, { value: true });
        const target = {};
        Object.defineProperty(target, 'value', { get: foreignGetter, configurable: true });
        freshCopy.installGuardedProperty(target, 'value', (getReal: () => unknown) => getReal);
        const fn = jest.fn(async () => 'ran');

        const running = freshCopy.runBlocked(fn);

        await expect(running).rejects.toThrow(FOREIGN_GUARD_MESSAGE);
        expect(fn).not.toHaveBeenCalled();
    });

    test('Should keep running when the installed guards are from this same release', async () => {
        let freshRunBlocked: typeof runBlocked | undefined;
        jest.isolateModules(() => {
            ({ runBlocked: freshRunBlocked } = require('./network-guard'));
        });
        if (!freshRunBlocked) {
            throw new Error('The fresh copy of network-guard did not load.');
        }

        const running = freshRunBlocked(async () => 'ran');

        await expect(running).resolves.toBe('ran');
    });
});

describe('exemptFetchFromBlockedScope', () => {
    test("Should run a wrapped module fetch outside the run's blocked scope while the run itself stays blocked", async () => {
        const hookOutput = path.join(probeDir, 'fetch-hook.txt');
        const afterFetchPath = path.join(probeDir, 'after-fetch.txt');
        const fetchModule = async (id: string) => {
            fs.writeFileSync(hookOutput, id);
            return id;
        };
        const exemptFetch = exemptFetchFromBlockedScope(fetchModule);

        const fetched = await runBlocked(async () => {
            const result = await exemptFetch('/src/lazy.ts');
            expect(() => fs.writeFileSync(afterFetchPath, 'data')).toThrow(
                FS_WRITE_BLOCKED_MESSAGE,
            );
            return result;
        });
        const hookContent = fs.readFileSync(hookOutput, 'utf8');
        const afterFetchWritten = fs.existsSync(afterFetchPath);

        expect(fetched).toBe('/src/lazy.ts');
        expect(hookContent).toBe('/src/lazy.ts');
        expect(afterFetchWritten).toBe(false);
    });

    test('Should reject a non-string module id without calling the real fetch', async () => {
        const fetchModule = jest.fn(async (id: string) => id);
        const exemptFetch = exemptFetchFromBlockedScope(fetchModule);
        const nonStringId: unknown = { toString: () => '/src/lazy.ts' };

        const fetching = Reflect.apply(exemptFetch, undefined, [nonStringId]);

        await expect(fetching).rejects.toThrow(NON_STRING_MODULE_ID_MESSAGE);
        expect(fetchModule).not.toHaveBeenCalled();
    });
});

describe('exemptPluginContainerFromBlockedScope', () => {
    test('Should reject a non-string id on a Vite 5 plugin container method without calling it', async () => {
        const resolveId = jest.fn(async (id: unknown) => id);
        const transform = jest.fn(async (_code: unknown, id: unknown) => id);
        const container = { resolveId, transform };
        exemptPluginContainerFromBlockedScope(container);
        const nonStringId: unknown = { toString: () => '/src/lazy.ts' };

        const resolving = container.resolveId(nonStringId);
        const transforming = container.transform('code', nonStringId);

        await expect(resolving).rejects.toThrow(NON_STRING_MODULE_ID_MESSAGE);
        await expect(transforming).rejects.toThrow(NON_STRING_MODULE_ID_MESSAGE);
        expect(resolveId).not.toHaveBeenCalled();
        expect(transform).not.toHaveBeenCalled();
    });
});

describe('installGuardedProperty resilience', () => {
    // A wrapper closure over the previous guard (some mocking libraries' pattern, distinct from the
    // direct-reassignment case the WeakMap handles) would otherwise recurse into itself forever,
    // since its captured getReal() would read the shared `real` variable the new guard just set.
    test('Should not recurse when a guard is restored via a wrapper closure instead of direct reassignment', () => {
        const originalWriteFileSync = fs.writeFileSync;
        try {
            const realMock = jest.fn().mockReturnValue('real result');
            Reflect.set(fs, 'writeFileSync', realMock);
            const previous = fs.writeFileSync;

            Reflect.set(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) =>
                previous(...args),
            );

            const writeResult = fs.writeFileSync('probe.txt', 'data');
            expect(writeResult).toBe('real result');
        } finally {
            Reflect.set(fs, 'writeFileSync', originalWriteFileSync);
        }
    });
});

describe('network access', () => {
    // Local dev deliberately allows network, matching Terrapin's production sandbox.
    test('Should let a direct fetch() inside fn reach the delegate without any exemption', async () => {
        const originalFetch = globalThis.fetch;
        const fetchedUrls: string[] = [];
        const fakeFetch: typeof fetch = async (input) => {
            const url = String(input);
            fetchedUrls.push(url);
            return new Response('ok');
        };
        setGlobalFetch(fakeFetch);
        try {
            const response = await runBlocked(() => fetch('https://example.com/direct'));
            const body = await response.text();

            expect(body).toBe('ok');
            expect(fetchedUrls).toEqual(['https://example.com/direct']);
        } finally {
            setGlobalFetch(originalFetch);
        }
    });

    test('Should let a real socket listen and connect inside fn', async () => {
        const received = await runBlocked(async () => {
            const server = net.createServer((socket) => socket.end('pong'));
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            try {
                return await new Promise<string>((resolve, reject) => {
                    const client = net.connect(port, '127.0.0.1');
                    let data = '';
                    client.on('data', (chunk) => {
                        data += String(chunk);
                    });
                    client.on('end', () => resolve(data));
                    client.on('error', reject);
                });
            } finally {
                server.close();
            }
        });

        expect(received).toBe('pong');
    });
});

describe('graceful-fs compatibility', () => {
    // graceful-fs clones fs's own property descriptors (copying the guard's non-configurable
    // accessors), then reassigns open/rename/... on the clone; win32 also exercises its rename patch.
    test('Should let graceful-fs load after the guard and patch its own clone of fs, and fail a blocked win32 rename fast', async () => {
        const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        let gracefulFs: typeof fs | undefined;
        try {
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            jest.isolateModules(() => {
                gracefulFs = require('graceful-fs');
            });
        } finally {
            if (realPlatform) {
                Object.defineProperty(process, 'platform', realPlatform);
            }
        }

        expect(gracefulFs?.open).toEqual(expect.any(Function));
        expect(gracefulFs?.open).not.toBe(fs.open);

        // Its win32 rename polyfill retries EACCES/EPERM for up to 60s; a blocked rename must not.
        const from = path.join(probeDir, 'rename-from.txt');
        const to = path.join(probeDir, 'rename-to.txt');
        fs.writeFileSync(from, 'data');
        const err = await runBlocked(
            () =>
                new Promise<Error | null>((resolve) => {
                    gracefulFs?.rename(from, to, resolve);
                }),
        );
        expect(err).toMatchObject({ code: 'EROFS' });
    });

    test("Should still block a write made through graceful-fs's patched clone inside fn", async () => {
        let gracefulFs: typeof fs | undefined;
        jest.isolateModules(() => {
            gracefulFs = require('graceful-fs');
        });
        const probeFile = path.join(probeDir, 'graceful-fs.txt');
        fs.writeFileSync(probeFile, 'ORIGINAL');

        await runBlocked(async () => {
            const err = await new Promise<Error | null>((resolve) => {
                gracefulFs?.writeFile(probeFile, 'replacement', resolve);
            });
            expect(err?.message).toMatch(FS_WRITE_BLOCKED_MESSAGE);
        });
        const content = fs.readFileSync(probeFile, 'utf8');
        expect(content).toBe('ORIGINAL');
    });

    test('Should accept a reassignment through a clone that copied the guarded accessor, without repointing the original', () => {
        const target: { value: unknown } = { value: () => 'real' };
        installGuardedProperty(
            target,
            'value',
            (getReal: () => () => unknown) =>
                (...args: unknown[]) => {
                    const real = getReal();
                    return Reflect.apply(real, undefined, args);
                },
        );
        const clone: { value: unknown } = { value: undefined };
        const guardedDescriptor = Object.getOwnPropertyDescriptor(target, 'value');
        if (guardedDescriptor) {
            Reflect.deleteProperty(clone, 'value');
            Object.defineProperty(clone, 'value', guardedDescriptor);
        }
        const replacement = () => 'clone';

        clone.value = replacement;
        const guardedValue = Object(target.value);
        const originalResult = Reflect.apply(guardedValue, undefined, []);

        expect(clone.value).toBe(replacement);
        expect(target.value).not.toBe(replacement);
        expect(originalResult).toBe('real');
    });
});

describe('installGuardedProperty security', () => {
    // A dependency could otherwise call `Object.defineProperty(target, 'value', {...})` directly to
    // replace the whole descriptor, silently restoring the real function.
    test('Should make a guarded property non-configurable, closing the Object.defineProperty bypass, while still allowing plain reassignment', () => {
        const target: { value: unknown } = { value: () => 'real' };
        installGuardedProperty(
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
    });

    // A defineProperty collision must fail loudly rather than silently leave the real function in place.
    test('Should rethrow rather than silently relax configurability when defineProperty fails', () => {
        const target: { value: unknown } = { value: () => 'real' };
        Object.defineProperty(target, 'value', {
            value: () => 'real',
            configurable: false,
            writable: false,
        });

        expect(() =>
            installGuardedProperty(
                target,
                'value',
                (getReal: () => () => unknown) =>
                    (...args: unknown[]) =>
                        (getReal() as (...a: unknown[]) => unknown)(...args),
            ),
        ).toThrow(/Cannot redefine property/);
    });

    // `oneChild.spawn = mock` on a guarded shared prototype must shadow that instance only, not
    // repoint the delegate every other instance calls through.
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

    // Matches a fs write method absent on an older Node runtime: wrapping a method that doesn't
    // exist would make feature-detection lie, then crash the moment a library actually calls it.
    test('Should skip installing a guard entirely when the target property does not exist on this runtime', () => {
        const target: Record<string, unknown> = {};
        installGuardedProperty(target, 'doesNotExist', () => () => 'guard');
        expect(Object.prototype.hasOwnProperty.call(target, 'doesNotExist')).toBe(false);
    });

    // isCurrentlyBlocked() is the shared gate for every guard in this file, so a fake context
    // swapped in by any code holding an `fs` reference would silently disable all of them at once.
    test('Should protect the shared-context registry entries stashed on `fs` from being overwritten by any code holding an `fs` reference', () => {
        const symbol = networkGuardSymbol('blockedContext');
        const descriptor = Object.getOwnPropertyDescriptor(fs, symbol);
        expect(descriptor).toMatchObject({ writable: false, configurable: false });

        expect(() => {
            Object.defineProperty(fs, symbol, {
                configurable: true,
                value: {
                    current: () => undefined,
                    run: (_scope: unknown, fn: () => unknown) => fn(),
                },
            });
        }).toThrow(/Cannot redefine property/);
    });

    // A raw AsyncLocalStorage on the registry would let any code with `require('fs')` call
    // `.disable()` on it and permanently disarm every future runBlocked call.
    test('Should not let a `.disable()` call reached via the `fs`-keyed registry entry disarm write blocking for a later runBlocked call', async () => {
        const symbol = networkGuardSymbol('blockedContext');
        const entry: unknown = Reflect.get(fs, symbol);
        const entryObject = Object(entry);
        const disable: unknown = Reflect.get(entryObject, 'disable');
        const getStore: unknown = Reflect.get(entryObject, 'getStore');
        const probePath = path.join(probeDir, 'disable.txt');

        expect(disable).toBeUndefined();
        expect(getStore).toBeUndefined();
        await expect(
            runBlocked(async () => {
                await fs.promises.writeFile(probePath, 'data');
            }),
        ).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
    });

    // A non-writable registry property stops replacement, not reassignment of the facade's own methods.
    test('Should freeze the shared facade so its current/run methods cannot be reassigned', () => {
        const symbol = networkGuardSymbol('blockedContext');
        const entry: unknown = Reflect.get(fs, symbol);
        const entryObject = Object(entry);
        const reassigned = Reflect.set(entryObject, 'current', () => undefined);
        const frozen = Object.isFrozen(entry);

        expect(entryObject).toBe(entry);
        expect(frozen).toBe(true);
        expect(reassigned).toBe(false);
    });

    // Uses fs's actual prototype, since a sandboxed test runtime can give core modules a non-Object one.
    test("Should not mistake a value inherited from fs's own prototype chain for an already-installed registry entry", () => {
        // Unique per run: a key installed by an earlier run in this process would skip the path under test.
        const probeKey = `pollutionProbe-${Date.now()}-${Math.random()}`;
        const symbol = networkGuardSymbol(probeKey);
        const pollutedFacade = {
            current: () => undefined,
            run: (_scope: unknown, fn: () => unknown) => fn(),
        };
        const fsPrototype: object = Object.getPrototypeOf(fs);

        try {
            const polluted = Reflect.set(fsPrototype, symbol, pollutedFacade);
            expect(polluted).toBe(true);

            const context = getSharedContext(probeKey);
            const installedAsOwnProperty = Object.prototype.hasOwnProperty.call(fs, symbol);
            // The polluted facade's current() is always undefined, so this distinguishes the real one.
            const probeScope = {
                tempDir: probeDir,
                tempDirRealPath: probeDir,
                writableFds: new Set<number>(),
                writableHandles: new WeakSet<object>(),
                pendingOperations: 0,
                closed: false,
            };
            const scopeInsideRun = context.run(probeScope, () => context.current());

            expect(context).not.toBe(pollutedFacade);
            expect(installedAsOwnProperty).toBe(true);
            expect(scopeInsideRun).toBe(probeScope);
        } finally {
            // The own-property entry getSharedContext installed is permanent by design.
            Reflect.deleteProperty(fsPrototype, symbol);
        }
    });
});

describe('guardWorker', () => {
    // `new Proxy()` needs a constructor, so a non-constructor value is returned unwrapped.
    test('Should return a non-constructor Worker value unchanged', () => {
        expect(guardWorker(() => undefined)).toBeUndefined();
    });
});

describe('construct-trap newTarget forwarding', () => {
    // Discarding newTarget would make `class Foo extends Worker {}` silently produce a base
    // instance instead — exercised against a fake constructor to avoid real construction side effects.
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
