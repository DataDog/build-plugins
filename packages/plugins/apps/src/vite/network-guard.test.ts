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
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import vm from 'vm';
import worker_threads from 'worker_threads';

import { makeProbeDirOutsideTmp } from './network-guard.fixtures';
import {
    ALREADY_GUARDED,
    ENDED_RUN_WRITE_BLOCKED_MESSAGE,
    exemptFetchFromBlockedScope,
    exemptPluginContainerFromBlockedScope,
    FILE_HANDLE_GUARD_UNAVAILABLE_MESSAGE,
    FOREIGN_GUARD_MESSAGE,
    FS_WRITE_BLOCKED_MESSAGE,
    getSharedContext,
    gracefulFsPredatesGuards,
    guardWorker,
    installGuardedProperty,
    installGuards,
    LINK_OR_COPY_BLOCKED_MESSAGE,
    networkGuardSymbol,
    NON_STRING_MODULE_ID_MESSAGE,
    OLDER_GUARD_MESSAGE,
    PROJECT_WRITE_BLOCKED_MESSAGE,
    RECURSIVE_COPY_BLOCKED_MESSAGE,
    runBlocked,
    RUNTIME_FALLBACK_NOTE,
    SUBPROCESS_BLOCKED_MESSAGE,
    UNCHECKABLE_PATH_BLOCKED_MESSAGE,
    UNCHECKABLE_WRITE_BLOCKED_MESSAGE,
    withRuntimeFallbackNote,
    WORKER_THREAD_BLOCKED_MESSAGE,
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
    test.each([
        { description: 'subprocess', message: SUBPROCESS_BLOCKED_MESSAGE },
        { description: 'worker thread', message: WORKER_THREAD_BLOCKED_MESSAGE },
        { description: 'fs write', message: FS_WRITE_BLOCKED_MESSAGE },
    ])(
        'Should say the v1 runtime refuses the blocked $description, so it fails in production too',
        ({ message }) => {
            expect(message).toContain('the v1 backend function runtime does not allow it');
        },
    );

    test.each([
        { description: 'project-directory block', message: PROJECT_WRITE_BLOCKED_MESSAGE },
        { description: 'symlink and cp block', message: LINK_OR_COPY_BLOCKED_MESSAGE },
        { description: 'recursive cp block', message: RECURSIVE_COPY_BLOCKED_MESSAGE },
        { description: 'ended-run block', message: ENDED_RUN_WRITE_BLOCKED_MESSAGE },
        { description: 'untracked fd block', message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE },
        { description: 'unreadable path block', message: UNCHECKABLE_PATH_BLOCKED_MESSAGE },
    ])(
        'Should call the $description a local-only protection, not a runtime rule',
        ({ message }) => {
            expect(message).toContain('local-only protection');
            expect(message).not.toContain('runtime does not allow');
        },
    );

    test('Should name the Vite project root as what the project-directory block protects', () => {
        expect(PROJECT_WRITE_BLOCKED_MESSAGE).toContain('Vite project root');
        expect(PROJECT_WRITE_BLOCKED_MESSAGE).not.toContain('source files');
    });

    test('Should put the fallback note before the final period', () => {
        const noted = withRuntimeFallbackNote(SUBPROCESS_BLOCKED_MESSAGE);
        const withoutPeriod = SUBPROCESS_BLOCKED_MESSAGE.slice(0, -1);

        expect(noted).toBe(`${withoutPeriod} ${RUNTIME_FALLBACK_NOTE}.`);
    });

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
                expect(err.message).toMatch(SUBPROCESS_BLOCKED_MESSAGE);
            });

            await runBlocked(async () => {
                let child: ReturnType<typeof child_process.fork> | undefined;
                expect(() => {
                    child = child_process.fork('./some-script.js');
                }).not.toThrow();
                const err = await new Promise<Error>((resolve) => child?.once('error', resolve));
                expect(err.message).toMatch(SUBPROCESS_BLOCKED_MESSAGE);
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
                expect(result?.error?.message).toMatch(SUBPROCESS_BLOCKED_MESSAGE);
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
                expect(err.message).toMatch(SUBPROCESS_BLOCKED_MESSAGE);
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
                expect(err.message).toMatch(SUBPROCESS_BLOCKED_MESSAGE);
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
            ).rejects.toThrow(SUBPROCESS_BLOCKED_MESSAGE);
            await expect(
                runBlocked(async () => {
                    child_process.execFileSync('curl', ['https://example.com']);
                }),
            ).rejects.toThrow(SUBPROCESS_BLOCKED_MESSAGE);
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
                message: expect.stringContaining(SUBPROCESS_BLOCKED_MESSAGE),
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
            ).rejects.toThrow(SUBPROCESS_BLOCKED_MESSAGE);
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
                expect(err.message).toMatch(SUBPROCESS_BLOCKED_MESSAGE);
            });
        });

        // A worker gets a fresh V8 realm with its own module registry, so nothing inside it inherits
        // this file's monkeypatches — the only enforceable boundary is blocking construction itself.
        test('Should block new Worker(...) construction made inside fn', async () => {
            await expect(
                runBlocked(async () => {
                    new worker_threads.Worker('', { eval: true });
                }),
            ).rejects.toThrow(WORKER_THREAD_BLOCKED_MESSAGE);
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

            const run = runBlocked(async () => {
                fs.writeFileSync(lossyPath, 'data');
            });

            await expect(run).rejects.toMatchObject({ message: UNCHECKABLE_PATH_BLOCKED_MESSAGE });
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

        // readFile opens the file itself rather than through the guarded fs.open, so its flag can
        // truncate or create a file.
        const readFileForms: Array<{
            api: string;
            read: (target: string, flag: string) => Promise<unknown>;
        }> = [
            {
                api: 'fs.readFileSync',
                read: async (target, flag) => fs.readFileSync(target, { flag }),
            },
            // UTF-8 reads take a separate native fast path.
            {
                api: 'fs.readFileSync with utf8',
                read: async (target, flag) => fs.readFileSync(target, { flag, encoding: 'utf8' }),
            },
            {
                api: 'fs.readFile',
                read: (target, flag) =>
                    new Promise((resolve, reject) => {
                        fs.readFile(target, { flag }, (err, data) =>
                            err ? reject(err) : resolve(data),
                        );
                    }),
            },
            {
                api: 'fs.promises.readFile',
                read: (target, flag) => fs.promises.readFile(target, { flag }),
            },
        ];

        test.each(readFileForms)(
            'Should refuse $api with a write flag outside the temp dir',
            async ({ read }) => {
                fs.writeFileSync(testFile, 'kept');
                const createdFile = path.join(tmpDir, 'created.txt');
                await runBlocked(async () => {
                    await expect(read(testFile, 'w')).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
                    await expect(read(createdFile, 'a')).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
                });
                const content = fs.readFileSync(testFile, 'utf8');
                const createdExists = fs.existsSync(createdFile);

                expect(content).toBe('kept');
                expect(createdExists).toBe(false);
            },
        );

        // Streams open through the guarded fs.open, so their flags are covered there.
        test('Should refuse fs.createReadStream with a write flag outside the temp dir', async () => {
            fs.writeFileSync(testFile, 'kept');
            const streamError = await runBlocked(
                () =>
                    new Promise<Error>((resolve) => {
                        fs.createReadStream(testFile, { flags: 'w' }).on('error', resolve);
                    }),
            );
            const content = fs.readFileSync(testFile, 'utf8');

            expect(streamError.message).toBe(FS_WRITE_BLOCKED_MESSAGE);
            expect(content).toBe('kept');
        });

        test.each(readFileForms)(
            'Should allow $api with a read flag anywhere and a write flag under the temp dir',
            async ({ api, read }) => {
                fs.writeFileSync(testFile, 'outside');
                const tmpFile = path.join(tmpWorkDir, `${api.replace(/\W/g, '-')}.txt`);
                fs.writeFileSync(tmpFile, 'inside');
                const contents = await runBlocked(async () => [
                    String(await read(testFile, 'r')),
                    String(await read(tmpFile, 'r+')),
                ]);

                expect(contents).toEqual(['outside', 'inside']);
            },
        );

        // An fd opened for writing before the blocked scope started is still refused.
        test('Should block fs.writeSync made inside fn on an fd from openSync', async () => {
            const fd = fs.openSync(testFile, 'w');
            try {
                await expect(
                    runBlocked(async () => {
                        fs.writeSync(fd, 'data');
                    }),
                ).rejects.toThrow(UNCHECKABLE_WRITE_BLOCKED_MESSAGE);
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
                ).rejects.toThrow(UNCHECKABLE_WRITE_BLOCKED_MESSAGE);
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
                    expect(err?.message).toMatch(UNCHECKABLE_WRITE_BLOCKED_MESSAGE);
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
                    expect(err?.message).toMatch(UNCHECKABLE_WRITE_BLOCKED_MESSAGE);
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
                ).rejects.toThrow(UNCHECKABLE_WRITE_BLOCKED_MESSAGE);
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
            expect(() => fs.symlinkSync(outsideFile, link)).toThrow(LINK_OR_COPY_BLOCKED_MESSAGE);
            const promiseSymlink = fs.promises.symlink(outsideFile, promiseLink);
            await expect(promiseSymlink).rejects.toThrow(LINK_OR_COPY_BLOCKED_MESSAGE);
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
                LINK_OR_COPY_BLOCKED_MESSAGE,
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
            expect(() => fs.ftruncateSync(2, 0)).toThrow(UNCHECKABLE_WRITE_BLOCKED_MESSAGE);
            expect(() => fs.fchmodSync(1, 0o600)).toThrow(UNCHECKABLE_WRITE_BLOCKED_MESSAGE);
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
            expect(() => fs.writeSync(fd, 'data')).toThrow(UNCHECKABLE_WRITE_BLOCKED_MESSAGE);
        });
    });

    // Closing outside the run must still revoke the fd, or the OS's next file with that number
    // would inherit write access; an unrevoked fd fails with EBADF instead of the guard's error.
    test('Should forget a temp fd closed from outside the run', async () => {
        const closedElsewhereError = await writeAfterClosingOutsideRun(runBlocked);

        expect(closedElsewhereError).toMatchObject({ message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE });
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

        expect(closedElsewhereError).toMatchObject({ message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE });
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

        expect(lateWriteError).toMatchObject({ message: ENDED_RUN_WRITE_BLOCKED_MESSAGE });
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
                expect(() => fs.writeSync(outsideFd, 'data')).toThrow(
                    UNCHECKABLE_WRITE_BLOCKED_MESSAGE,
                );
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

        expect(lateWriteError).toMatchObject({ message: ENDED_RUN_WRITE_BLOCKED_MESSAGE });
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
            expect(outsideError).toMatchObject({ message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE });
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
        expect(child.stdout).toBe(`refused: ${UNCHECKABLE_WRITE_BLOCKED_MESSAGE}\n`);
    });
});

// A patched fs.promises.open can hand the FileHandle guard a plain object, whose prototype is Object's.
describe('a FileHandle prototype captured from a patched open', () => {
    test('Should still run when open hands back a plain object, checking paths as usual', () => {
        const bundlePath = buildGuardBundle('network-guard-patched-open.bundle.cjs');
        const childTmpDir = path.join(probeDir, 'patched-open-tmp');
        fs.mkdirSync(childTmpDir, { recursive: true });
        const projectDir = path.join(probeDir, 'patched-open-project');
        fs.mkdirSync(projectDir, { recursive: true });
        const target = path.join(projectDir, 'target.txt');
        fs.writeFileSync(target, 'data');
        const probeScript = [
            "const fs = require('fs');",
            "const os = require('os');",
            "const path = require('path');",
            "const { pathToFileURL } = require('url');",
            'const realOpen = fs.promises.open;',
            'fs.promises.open = (file, ...rest) =>',
            '    file === os.devNull ? Promise.resolve({ fd: -1, close: async () => {} }) : realOpen(file, ...rest);',
            'const guard = require(process.argv[1]);',
            'const target = process.argv[2];',
            'const v2 = { runtime: "v2", projectRoot: path.dirname(target) };',
            'const attempt = (write, options) =>',
            "    guard.runBlocked(write, options).then(() => 'allowed', (err) => 'refused: ' + err.message);",
            '(async () => {',
            "    console.log(await attempt(async () => fs.writeFileSync(path.join(os.tmpdir(), 'in-tmp.txt'), 'x')));",
            "    console.log(await attempt(() => fs.promises.readFile(Buffer.from(target), { flag: 'w' })));",
            "    console.log(await attempt(() => fs.promises.readFile(pathToFileURL(target), { flag: 'w' })));",
            "    console.log(await attempt(async () => fs.writeFileSync(Buffer.from(target), 'x')));",
            "    console.log(await attempt(async () => fs.writeFileSync(Buffer.from(target), 'x'), v2));",
            '})();',
        ].join('\n');

        const child = child_process.spawnSync(
            process.execPath,
            ['-e', probeScript, bundlePath, target],
            {
                encoding: 'utf8',
                env: { PATH: process.env.PATH, TMPDIR: childTmpDir },
            },
        );

        const outsideTmp = `refused: ${FS_WRITE_BLOCKED_MESSAGE}`;
        const projectWrite = `refused: ${PROJECT_WRITE_BLOCKED_MESSAGE}`;
        const contents = fs.readFileSync(target, 'utf8');
        expect(child.stderr).toBe('');
        expect(child.stdout).toBe(
            `allowed\n${outsideTmp}\n${outsideTmp}\n${outsideTmp}\n${projectWrite}\n`,
        );
        expect(contents).toBe('data');
    });
});

describe('a FileHandle guard that cannot install', () => {
    test('Should refuse to run when open rejects the null-device probe', () => {
        const bundlePath = buildGuardBundle('network-guard-rejected-open.bundle.cjs');
        const childTmpDir = path.join(probeDir, 'rejected-open-tmp');
        fs.mkdirSync(childTmpDir, { recursive: true });
        const probeScript = [
            "const fs = require('fs');",
            "const os = require('os');",
            'const realOpen = fs.promises.open;',
            'fs.promises.open = (file, ...rest) =>',
            "    file === os.devNull ? Promise.reject(new Error('no device')) : realOpen(file, ...rest);",
            'const guard = require(process.argv[1]);',
            'guard',
            "    .runBlocked(async () => 'ran')",
            "    .then((result) => console.log(result), (err) => console.log('refused: ' + err.message));",
        ].join('\n');

        const child = child_process.spawnSync(process.execPath, ['-e', probeScript, bundlePath], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, TMPDIR: childTmpDir },
        });

        expect(child.stderr).toBe('');
        expect(child.stdout).toBe(`refused: ${FILE_HANDLE_GUARD_UNAVAILABLE_MESSAGE}\n`);
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
            expect(lateWriteError).toMatchObject({ message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE });
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

        expect(lateWriteError).toMatchObject({ message: ENDED_RUN_WRITE_BLOCKED_MESSAGE });
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
            expect(lateWriteError).toMatchObject({ message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE });
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

    // On Terrapin's Linux os.tmpdir() is /tmp, so a dependency that hard-codes /tmp works there.
    test('Should allow writes under /tmp even when os.tmpdir() is elsewhere', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const suffix = `${process.pid}-${Date.now()}`;
        const slashTmpFile = path.join('/tmp', `dd-slash-tmp-${suffix}.txt`);
        try {
            await runBlocked(async () => {
                fs.writeFileSync(slashTmpFile, 'data');
            });
            const content = fs.readFileSync(slashTmpFile, 'utf8');

            expect(content).toBe('data');
        } finally {
            rmSync(slashTmpFile);
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
        expect(afterClose).toMatchObject({ message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE });
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
        const refused = expect.objectContaining({ message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE });

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

    // Released copies share this copy's context and mark their accessors with the same generation,
    // but their wrappers ignore `policy`.
    function loadBesideReleasedGuard() {
        let freshCopy: typeof import('./network-guard') | undefined;
        jest.isolateModules(() => {
            freshCopy = require('./network-guard');
        });
        if (!freshCopy) {
            throw new Error('The fresh copy of network-guard did not load.');
        }
        const releasedGetter = () => () => {
            throw new Error('Spawning a subprocess is not allowed in backend functions.');
        };
        Object.defineProperty(releasedGetter, ALREADY_GUARDED, { value: true });
        const releasedGeneration = Symbol.for('@dd/apps-plugin/network-guard/v3 installed');
        Object.defineProperty(releasedGetter, releasedGeneration, { value: true });
        const target: { execSync?: () => unknown } = {};
        Object.defineProperty(target, 'execSync', { get: releasedGetter, configurable: true });
        freshCopy.installGuardedProperty(target, 'execSync', (getReal: () => unknown) => getReal);
        return { freshCopy, target };
    }

    test("Should refuse a v2 run when a released copy's guard is installed, instead of applying its v1 blocks", async () => {
        const { freshCopy, target } = loadBesideReleasedGuard();
        const fn = jest.fn(async () => target.execSync?.());

        const running = freshCopy.runBlocked(fn, { runtime: 'v2', projectRoot: probeDir });

        await expect(running).rejects.toThrow(OLDER_GUARD_MESSAGE);
        expect(fn).not.toHaveBeenCalled();
    });

    test("Should keep running a v1 run under a released copy's guard, which enforces v1's blocks", async () => {
        const { freshCopy } = loadBesideReleasedGuard();

        const running = freshCopy.runBlocked(async () => 'ran', { runtime: 'v1' });

        await expect(running).resolves.toBe('ran');
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
    // Local dev deliberately allows network, as Terrapin does.
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

    // getBlockedContext().current() is the shared gate for every guard in this file, so a fake context
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

describe('backend runtime policy', () => {
    const PRINT_OK = "process.stdout.write('ok')";
    const ORIGINAL_SOURCE = 'original';

    // Each project gets its own parent, so a regression that lets removing the parent through deletes
    // only that per-test directory, not probeDir.
    let projectParent: string;
    let projectRoot: string;
    let sourceFile: string;
    let outsideDir: string;
    beforeEach(() => {
        const projectParentPrefix = path.join(probeDir, 'project-parent-');
        projectParent = fs.mkdtempSync(projectParentPrefix);
        projectRoot = path.join(projectParent, 'project');
        fs.mkdirSync(projectRoot);
        sourceFile = path.join(projectRoot, 'source.ts');
        fs.writeFileSync(sourceFile, ORIGINAL_SOURCE);
        const outsidePrefix = path.join(probeDir, 'outside-project-');
        outsideDir = fs.mkdtempSync(outsidePrefix);
    });
    afterEach(() => {
        rmSync(projectParent);
        rmSync(outsideDir);
    });

    function runV2<T>(fn: () => Promise<T>): Promise<T> {
        return runBlocked(fn, { runtime: 'v2', projectRoot });
    }

    function entryExists(entryPath: string): boolean {
        try {
            fs.lstatSync(entryPath);
            return true;
        } catch {
            return false;
        }
    }

    test.each([
        {
            name: 'execSync',
            spawn: () => child_process.execSync(`"${process.execPath}" -e "${PRINT_OK}"`),
        },
        {
            name: 'execFileSync',
            spawn: () => child_process.execFileSync(process.execPath, ['-e', PRINT_OK]),
        },
        {
            name: 'spawnSync',
            spawn: () => child_process.spawnSync(process.execPath, ['-e', PRINT_OK]).stdout,
        },
    ])('Should let a v2 run spawn a subprocess with $name', async ({ spawn }) => {
        const output = await runV2(async () => spawn().toString());

        expect(output).toBe('ok');
    });

    test('Should let a v2 run start a worker thread', async () => {
        const message = await runV2(async () => {
            const worker = new worker_threads.Worker(
                "require('worker_threads').parentPort.postMessage('ok')",
                { eval: true },
            );
            const [received] = await once(worker, 'message');
            await worker.terminate();
            return received;
        });

        expect(message).toBe('ok');
    });

    test.each<{ name: string; write: (target: string) => Promise<unknown> }>([
        {
            name: 'writeFileSync',
            write: async (target: string) => fs.writeFileSync(target, 'data'),
        },
        {
            name: 'fs.promises.writeFile',
            write: (target: string) => fs.promises.writeFile(target, 'data'),
        },
        {
            name: 'an fd from openSync',
            write: async (target: string) => {
                const fd = fs.openSync(target, 'w');
                fs.writeSync(fd, 'data');
                fs.closeSync(fd);
            },
        },
        {
            name: 'a FileHandle from fs.promises.open',
            write: async (target: string) => {
                const handle = await fs.promises.open(target, 'w');
                await handle.writeFile('data');
                await handle.close();
            },
        },
        {
            name: 'a write stream',
            write: async (target: string) => {
                const stream = fs.createWriteStream(target);
                stream.end('data');
                await once(stream, 'close');
            },
        },
        {
            name: 'mkdirSync',
            write: async (target: string) => fs.mkdirSync(target, { recursive: true }),
        },
        {
            name: 'symlinkSync',
            write: async (target: string) => fs.symlinkSync(os.devNull, target),
        },
        {
            name: 'cpSync',
            write: async (target: string) => fs.cpSync(sourceFile, target),
        },
    ])(
        'Should let a v2 run write outside the temp and project directories with $name',
        async ({ write }) => {
            const target = path.join(outsideDir, 'written');

            await runV2(() => write(target));

            const written = entryExists(target);
            expect(written).toBe(true);
        },
    );

    test('Should let a v2 run write outside the project directory through a Uint8Array path', async () => {
        const target = path.join(outsideDir, 'written.txt');
        const encodedTarget = new TextEncoder().encode(target);

        await runV2(async () => Reflect.apply(fs.writeFileSync, fs, [encodedTarget, 'data']));

        const written = fs.readFileSync(target, 'utf8');
        expect(written).toBe('data');
    });

    test('Should let a v2 run remove a file outside the project directory', async () => {
        const target = path.join(outsideDir, 'removable.txt');
        fs.writeFileSync(target, 'data');

        await runV2(async () => fs.rmSync(target));

        const exists = entryExists(target);
        expect(exists).toBe(false);
    });

    test('Should let a v2 run mkdir the project directory or an ancestor, which already exist', async () => {
        await runV2(async () => {
            fs.mkdirSync(projectRoot, { recursive: true });
            fs.mkdirSync(projectParent, { recursive: true });
        });

        const projectEntries = fs.readdirSync(projectRoot);
        expect(projectEntries).toEqual(['source.ts']);
    });

    test('Should let a v2 run write in the temp dir', async () => {
        const target = path.join(tmpWorkDir, 'written.txt');

        await runV2(async () => fs.writeFileSync(target, 'data'));

        const contents = fs.readFileSync(target, 'utf8');
        expect(contents).toBe('data');
    });

    test.each<{ name: string; write: () => Promise<unknown> }>([
        {
            name: 'writeFileSync over a source file',
            write: async () => fs.writeFileSync(sourceFile, 'overwritten'),
        },
        {
            name: 'fs.promises.writeFile of a new file',
            write: () => {
                const newFile = path.join(projectRoot, 'new.ts');
                return fs.promises.writeFile(newFile, 'data');
            },
        },
        {
            name: 'the callback form of writeFile',
            write: () => promisify(fs.writeFile)(sourceFile, 'overwritten'),
        },
        {
            name: 'openSync with a write flag',
            write: async () => fs.openSync(sourceFile, 'w'),
        },
        {
            name: 'fs.promises.open with a write flag',
            write: () => fs.promises.open(sourceFile, 'w'),
        },
        {
            name: 'readFileSync with a write flag',
            write: async () => fs.readFileSync(sourceFile, { flag: 'w' }),
        },
        {
            name: 'fs.promises.readFile with a write flag',
            write: () => fs.promises.readFile(sourceFile, { flag: 'w+' }),
        },
        {
            name: 'mkdirSync inside the project',
            write: async () => {
                const newDir = path.join(projectRoot, 'new-dir');
                fs.mkdirSync(newDir);
            },
        },
        {
            name: 'rmSync of the project directory',
            write: async () => fs.rmSync(projectRoot, { recursive: true, force: true }),
        },
        {
            name: "rmSync of the project directory's parent",
            write: async () => fs.rmSync(projectParent, { recursive: true, force: true }),
        },
        {
            name: 'renameSync of a source file out of the project',
            write: async () => {
                const movedFile = path.join(outsideDir, 'moved.ts');
                fs.renameSync(sourceFile, movedFile);
            },
        },
        {
            name: 'renameSync onto a source file',
            write: async () => {
                const replacement = path.join(outsideDir, 'replacement.ts');
                fs.writeFileSync(replacement, 'replacement');
                fs.renameSync(replacement, sourceFile);
            },
        },
        {
            name: 'copyFileSync onto a source file',
            write: async () => {
                const replacement = path.join(outsideDir, 'replacement.ts');
                fs.writeFileSync(replacement, 'replacement');
                fs.copyFileSync(replacement, sourceFile);
            },
        },
        {
            name: 'cpSync onto a source file',
            write: async () => {
                const replacement = path.join(outsideDir, 'replacement.ts');
                fs.writeFileSync(replacement, 'replacement');
                fs.cpSync(replacement, sourceFile);
            },
        },
        {
            name: 'mkdtempSync with a prefix inside the project',
            write: async () => {
                const tmpPrefix = path.join(projectRoot, 'tmp-');
                fs.mkdtempSync(tmpPrefix);
            },
        },
        {
            name: 'linkSync of a source file out of the project',
            write: async () => {
                const hardLink = path.join(outsideDir, 'hard-link.ts');
                fs.linkSync(sourceFile, hardLink);
            },
        },
        {
            name: 'symlinkSync inside the project',
            write: async () => {
                const link = path.join(projectRoot, 'link');
                fs.symlinkSync(outsideDir, link);
            },
        },
        {
            name: 'writeFileSync through a link outside the project that points into it',
            write: async () => {
                const linkedSource = path.join(outsideDir, 'into-project', 'source.ts');
                fs.writeFileSync(linkedSource, 'x');
            },
        },
        {
            name: 'writeFileSync with a Uint8Array path to a source file',
            write: async () => {
                const encodedPath = new TextEncoder().encode(sourceFile);
                Reflect.apply(fs.writeFileSync, fs, [encodedPath, 'overwritten']);
            },
        },
        {
            name: 'fs.promises.readFile with a write flag and a Uint8Array path',
            write: () => {
                const encodedPath = new TextEncoder().encode(sourceFile);
                return Reflect.apply(fs.promises.readFile, fs.promises, [
                    encodedPath,
                    { flag: 'w+' },
                ]);
            },
        },
    ])(
        'Should refuse a v2 run writing inside the project directory with $name',
        async ({ write }) => {
            const linkIntoProject = path.join(outsideDir, 'into-project');
            fs.symlinkSync(projectRoot, linkIntoProject);

            const run = runV2(write);
            await expect(run).rejects.toMatchObject({
                message: PROJECT_WRITE_BLOCKED_MESSAGE,
                code: 'EROFS',
            });

            const sourceContents = fs.readFileSync(sourceFile, 'utf8');
            const projectEntries = fs.readdirSync(projectRoot);
            expect(sourceContents).toBe(ORIGINAL_SOURCE);
            expect(projectEntries).toEqual(['source.ts']);
        },
    );

    describe('a file the run did not open for writing', () => {
        let outsideFile: string;
        let preRunFd: number;
        let preRunWriteHandle: fs.promises.FileHandle;
        let readHandle: fs.promises.FileHandle;
        beforeEach(async () => {
            outsideFile = path.join(outsideDir, 'opened-before.txt');
            fs.writeFileSync(outsideFile, 'before');
            preRunFd = fs.openSync(outsideFile, 'r+');
            preRunWriteHandle = await fs.promises.open(outsideFile, 'r+');
            readHandle = await fs.promises.open(outsideFile, 'r');
        });
        afterEach(async () => {
            fs.closeSync(preRunFd);
            await preRunWriteHandle.close();
            await readHandle.close();
        });

        test.each<{ name: string; write: () => Promise<unknown> }>([
            {
                name: 'writeSync on an fd opened before the run',
                write: async () => fs.writeSync(preRunFd, 'x'),
            },
            {
                name: 'ftruncateSync on an fd opened before the run',
                write: async () => fs.ftruncateSync(preRunFd, 0),
            },
            {
                name: 'fs.promises.writeFile on a handle opened before the run',
                write: () => fs.promises.writeFile(preRunWriteHandle, 'x'),
            },
            {
                name: 'write on a handle opened before the run',
                write: () => preRunWriteHandle.write('x'),
            },
            { name: 'chmod on a read-mode handle', write: () => readHandle.chmod(0o600) },
            { name: 'truncate on a read-mode handle', write: () => readHandle.truncate(0) },
        ])(
            'Should refuse a v2 run using $name, saying the target cannot be checked',
            async ({ write }) => {
                const modeBefore = fs.statSync(outsideFile).mode;

                const run = runV2(write);
                await expect(run).rejects.toMatchObject({
                    message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE,
                    code: 'EROFS',
                });

                const contents = fs.readFileSync(outsideFile, 'utf8');
                const modeAfter = fs.statSync(outsideFile).mode;
                expect(contents).toBe('before');
                expect(modeAfter).toBe(modeBefore);
            },
        );

        test('Should give a v1 run the same untracked-fd message, since the fd may point into the temp dir', async () => {
            const run = runBlocked(async () => fs.writeSync(preRunFd, 'x'), {
                runtime: 'v1',
                projectRoot,
            });

            await expect(run).rejects.toMatchObject({ message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE });
        });

        test('Should let a v2 run write through an fd and a handle it opened outside the project', async () => {
            const target = path.join(outsideDir, 'opened-in-run.txt');

            await runV2(async () => {
                const fd = fs.openSync(target, 'w');
                fs.writeSync(fd, 'fd');
                fs.closeSync(fd);
                const handle = await fs.promises.open(target, 'a');
                await handle.write('+handle');
                await handle.close();
            });

            const contents = fs.readFileSync(target, 'utf8');
            expect(contents).toBe('fd+handle');
        });
    });

    test('Should keep the temp dir writable under v2 even when it sits inside the project directory', async () => {
        const tmpDir = os.tmpdir();
        const realTmpDir = fs.realpathSync.native(tmpDir);
        const enclosingProject = path.dirname(realTmpDir);
        const tmpTarget = path.join(tmpWorkDir, 'written.txt');
        const projectTarget = path.join(enclosingProject, `dd-network-guard-probe-${process.pid}`);

        try {
            const outcome = await runBlocked(
                async () => {
                    fs.writeFileSync(tmpTarget, 'data');
                    return fs.promises.writeFile(projectTarget, 'data').catch((err) => err);
                },
                { runtime: 'v2', projectRoot: enclosingProject },
            );

            const tmpContents = fs.readFileSync(tmpTarget, 'utf8');
            expect(tmpContents).toBe('data');
            expect(outcome).toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });
        } finally {
            fs.rmSync(projectTarget, { force: true });
        }
    });

    test('Should keep applying the v2 rules to a write that lands after the run ended', async () => {
        let releaseLateWrites: (() => void) | undefined;
        const lateWriteGate = new Promise<void>((resolve) => {
            releaseLateWrites = resolve;
        });
        const outsideTarget = path.join(outsideDir, 'late.txt');
        let lateWrites: Promise<unknown> | undefined;
        await runV2(async () => {
            lateWrites = lateWriteGate.then(async () => {
                await fs.promises.writeFile(outsideTarget, 'late');
                return fs.promises.writeFile(sourceFile, 'late').catch((err) => err);
            });
        });

        releaseLateWrites?.();
        const projectWriteError = await lateWrites;

        const outsideContents = fs.readFileSync(outsideTarget, 'utf8');
        const sourceContents = fs.readFileSync(sourceFile, 'utf8');
        expect(outsideContents).toBe('late');
        expect(projectWriteError).toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });
        expect(sourceContents).toBe(ORIGINAL_SOURCE);
    });

    test('Should protect the project when its directory is given through a symlink', async () => {
        const linkedRoot = path.join(outsideDir, 'linked-project');
        fs.symlinkSync(projectRoot, linkedRoot);

        const run = runBlocked(async () => fs.writeFileSync(sourceFile, 'overwritten'), {
            runtime: 'v2',
            projectRoot: linkedRoot,
        });

        await expect(run).rejects.toThrow(PROJECT_WRITE_BLOCKED_MESSAGE);
        const sourceContents = fs.readFileSync(sourceFile, 'utf8');
        expect(sourceContents).toBe(ORIGINAL_SOURCE);
    });

    test('Should protect the project when the temp dir is the project directory itself', async () => {
        const tmpDir = os.tmpdir();
        const realTmpDir = fs.realpathSync.native(tmpDir);
        const target = path.join(tmpWorkDir, 'written.txt');

        const run = runBlocked(async () => fs.writeFileSync(target, 'data'), {
            runtime: 'v2',
            projectRoot: realTmpDir,
        });

        await expect(run).rejects.toThrow(PROJECT_WRITE_BLOCKED_MESSAGE);
        const exists = fs.existsSync(target);
        expect(exists).toBe(false);
    });

    test("Should keep v1's blocks for a scope without a policy, such as an older copy's", () => {
        const scope = {
            writableFds: new Set<number>(),
            writableHandles: new WeakSet<object>(),
            closed: false,
        };
        const run = () =>
            getSharedContext('blockedContext').run(scope, () => {
                child_process.execSync(`"${process.execPath}" -e "${PRINT_OK}"`);
            });

        expect(run).toThrow(SUBPROCESS_BLOCKED_MESSAGE);
    });

    test.each([
        { name: 'v1', options: () => ({ runtime: 'v1', projectRoot }) },
        { name: 'no runtime', options: () => ({}) },
        { name: 'an unknown runtime', options: () => ({ runtime: 'v3', projectRoot }) },
        { name: 'v2 without a project directory', options: () => ({ runtime: 'v2' }) },
    ])("Should keep v1's blocks for $name", async ({ options }) => {
        const runOptions = options();
        const runWith = (fn: () => Promise<unknown>): Promise<unknown> =>
            Reflect.apply(runBlocked, undefined, [fn, runOptions]);
        const outsideTarget = path.join(outsideDir, 'written.txt');
        const tmpTarget = path.join(tmpWorkDir, 'written.txt');

        const subprocessRun = runWith(async () =>
            child_process.execSync(`"${process.execPath}" -e "${PRINT_OK}"`),
        );
        await expect(subprocessRun).rejects.toThrow(SUBPROCESS_BLOCKED_MESSAGE);
        const workerRun = runWith(async () => new worker_threads.Worker('', { eval: true }));
        await expect(workerRun).rejects.toThrow(WORKER_THREAD_BLOCKED_MESSAGE);
        const writeRun = runWith(async () => fs.writeFileSync(outsideTarget, 'data'));
        await expect(writeRun).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
        const symlinkRun = runWith(async () => fs.symlinkSync(os.devNull, outsideTarget));
        await expect(symlinkRun).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
        await runWith(async () => fs.writeFileSync(tmpTarget, 'data'));

        const outsideWritten = entryExists(outsideTarget);
        const tmpContents = fs.readFileSync(tmpTarget, 'utf8');
        expect(outsideWritten).toBe(false);
        expect(tmpContents).toBe('data');
    });

    test('Should refuse a write from an ended v1 run with the ended-run message inside the temp dir, and the v1 message outside it', async () => {
        let releaseLateWrites: (() => void) | undefined;
        const lateWriteGate = new Promise<void>((resolve) => {
            releaseLateWrites = resolve;
        });
        const tmpTarget = path.join(tmpWorkDir, 'late.txt');
        const outsideTarget = path.join(outsideDir, 'late.txt');
        let lateWrites: Promise<unknown[]> | undefined;
        await runBlocked(
            async () => {
                lateWrites = lateWriteGate.then(() => {
                    const tmpWrite = fs.promises.writeFile(tmpTarget, 'late').catch((err) => err);
                    const outsideWrite = fs.promises
                        .writeFile(outsideTarget, 'late')
                        .catch((err) => err);
                    return Promise.all([tmpWrite, outsideWrite]);
                });
            },
            { runtime: 'v1', projectRoot },
        );

        releaseLateWrites?.();
        const [tmpError, outsideError] = (await lateWrites) ?? [];

        const tmpWritten = entryExists(tmpTarget);
        const outsideWritten = entryExists(outsideTarget);
        expect(tmpError).toMatchObject({ message: ENDED_RUN_WRITE_BLOCKED_MESSAGE });
        expect(outsideError).toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
        expect(tmpWritten).toBe(false);
        expect(outsideWritten).toBe(false);
    });

    test('Should keep the v1 message for a symlink outside the temp dir', async () => {
        const link = path.join(outsideDir, 'link');

        const run = runBlocked(async () => fs.symlinkSync(os.devNull, link), { runtime: 'v1' });

        await expect(run).rejects.toMatchObject({ message: FS_WRITE_BLOCKED_MESSAGE });
    });

    describe('when v1 applies only because the runtime lookup failed', () => {
        function runFallback(fn: () => Promise<unknown>): Promise<unknown> {
            return runBlocked(fn, { runtime: 'v1', isFallbackRuntime: true, projectRoot });
        }

        test.each<{ name: string; refuse: () => Promise<unknown>; message: string }>([
            {
                name: 'a subprocess',
                refuse: async () =>
                    child_process.execSync(`"${process.execPath}" -e "${PRINT_OK}"`),
                message: SUBPROCESS_BLOCKED_MESSAGE,
            },
            {
                name: 'a spawned subprocess',
                refuse: async () => {
                    const child = child_process.spawn(process.execPath, ['-e', PRINT_OK]);
                    const [error] = await once(child, 'error');
                    throw error;
                },
                message: SUBPROCESS_BLOCKED_MESSAGE,
            },
            {
                name: 'a worker thread',
                refuse: async () => new worker_threads.Worker('', { eval: true }),
                message: WORKER_THREAD_BLOCKED_MESSAGE,
            },
            {
                name: 'a write outside the temp dir',
                refuse: async () => {
                    const target = path.join(outsideDir, 'written.txt');
                    fs.writeFileSync(target, 'data');
                },
                message: FS_WRITE_BLOCKED_MESSAGE,
            },
            {
                name: 'a symlink inside the temp dir',
                refuse: async () => {
                    const link = path.join(tmpWorkDir, 'link');
                    fs.symlinkSync(os.devNull, link);
                },
                message: LINK_OR_COPY_BLOCKED_MESSAGE,
            },
        ])('Should add the fallback note when refusing $name', async ({ refuse, message }) => {
            const expected = withRuntimeFallbackNote(message);

            const run = runFallback(refuse);
            await expect(run).rejects.toMatchObject({ message: expected });
        });

        test.each<{ name: string; refuse: () => Promise<unknown>; message: string }>([
            {
                name: 'a write into the Vite project root',
                refuse: async () => fs.writeFileSync(path.join(projectRoot, 'written.txt'), 'data'),
                message: FS_WRITE_BLOCKED_MESSAGE,
            },
            {
                name: 'a recursive cp inside the temp dir',
                refuse: async () =>
                    fs.cpSync(outsideDir, path.join(tmpWorkDir, 'copy'), { recursive: true }),
                message: LINK_OR_COPY_BLOCKED_MESSAGE,
            },
        ])('Should leave the note off $name, which v2 refuses too', async ({ refuse, message }) => {
            const run = runFallback(refuse);

            await expect(run).rejects.toMatchObject({ message });
        });

        test("Should leave the note off a refusal v2 makes too, since it doesn't depend on the runtime", async () => {
            const outsideFile = path.join(outsideDir, 'opened-before.txt');
            const preRunFd = fs.openSync(outsideFile, 'w');

            try {
                const run = runFallback(async () => fs.writeSync(preRunFd, 'x'));
                await expect(run).rejects.toMatchObject({
                    message: UNCHECKABLE_WRITE_BLOCKED_MESSAGE,
                });
            } finally {
                fs.closeSync(preRunFd);
            }
        });

        test('Should leave the note off a v1 run whose runtime was read', async () => {
            const run = runBlocked(
                async () => child_process.execSync(`"${process.execPath}" -e "${PRINT_OK}"`),
                { runtime: 'v1', isFallbackRuntime: false, projectRoot },
            );

            await expect(run).rejects.toMatchObject({ message: SUBPROCESS_BLOCKED_MESSAGE });
        });
    });

    test.each<{ name: string; copy: (source: string, destination: string) => Promise<unknown> }>([
        {
            name: 'cpSync',
            copy: async (source, destination) =>
                fs.cpSync(source, destination, { recursive: true }),
        },
        {
            name: 'fs.promises.cp',
            copy: (source, destination) => fs.promises.cp(source, destination, { recursive: true }),
        },
    ])('Should refuse a recursive $name under v2, naming the recursive copy', async ({ copy }) => {
        const copySource = path.join(outsideDir, 'copy-source');
        const linkedCopy = path.join(copySource, 'into-project');
        fs.mkdirSync(linkedCopy, { recursive: true });
        const copiedSource = path.join(linkedCopy, 'source.ts');
        fs.writeFileSync(copiedSource, 'overwritten');
        const linkIntoProject = path.join(outsideDir, 'into-project');
        fs.symlinkSync(projectRoot, linkIntoProject);
        const unrelatedDestination = path.join(outsideDir, 'unrelated-copy');

        const intoLink = runV2(() => copy(copySource, outsideDir));
        await expect(intoLink).rejects.toMatchObject({ message: RECURSIVE_COPY_BLOCKED_MESSAGE });
        const unrelated = runV2(() => copy(copySource, unrelatedDestination));
        await expect(unrelated).rejects.toMatchObject({ message: RECURSIVE_COPY_BLOCKED_MESSAGE });
        const sourceContents = fs.readFileSync(sourceFile, 'utf8');
        expect(sourceContents).toBe(ORIGINAL_SOURCE);
    });

    test.each<{ name: string; copy: (source: string, destination: string) => Promise<unknown> }>([
        { name: 'cpSync', copy: async (source, destination) => fs.cpSync(source, destination) },
        {
            name: 'fs.promises.cp',
            copy: (source, destination) => fs.promises.cp(source, destination),
        },
    ])(
        'Should refuse a v2 $name onto a symlink inside the project that points outside it',
        async ({ copy }) => {
            const outsideTarget = path.join(outsideDir, 'link-target.json');
            fs.writeFileSync(outsideTarget, 'outside');
            const linkInProject = path.join(projectRoot, 'linked.json');
            fs.symlinkSync(outsideTarget, linkInProject);
            const replacement = path.join(outsideDir, 'replacement.json');
            fs.writeFileSync(replacement, 'replacement');

            const run = runV2(() => copy(replacement, linkInProject));

            await expect(run).rejects.toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });
            const isStillLink = fs.lstatSync(linkInProject).isSymbolicLink();
            const outsideContents = fs.readFileSync(outsideTarget, 'utf8');
            expect(isStillLink).toBe(true);
            expect(outsideContents).toBe('outside');
        },
    );

    test.each([
        { name: 'v1', options: () => ({ runtime: 'v1' as const }), dir: () => tmpWorkDir },
        {
            name: 'v2',
            options: () => ({ runtime: 'v2' as const, projectRoot }),
            dir: () => outsideDir,
        },
    ])(
        'Should refuse a $name write through a dangling symlink, saying the path cannot be resolved',
        async ({ options, dir }) => {
            const linkDir = dir();
            const missing = path.join(linkDir, 'missing', 'file.txt');
            const dangling = path.join(linkDir, 'dangling');
            fs.symlinkSync(missing, dangling);
            const runOptions = options();

            const run = runBlocked(async () => fs.writeFileSync(dangling, 'x'), runOptions);

            await expect(run).rejects.toMatchObject({ message: UNCHECKABLE_PATH_BLOCKED_MESSAGE });
        },
    );

    test('Should refuse removing a symlinked parent on the configured project path', async () => {
        const realWork = path.join(outsideDir, 'real-work');
        const realApp = path.join(realWork, 'app');
        fs.mkdirSync(realApp, { recursive: true });
        const linkedWork = path.join(outsideDir, 'work');
        fs.symlinkSync(realWork, linkedWork);
        const configuredRoot = path.join(linkedWork, 'app');
        const movedLink = path.join(outsideDir, 'moved-work');

        const removal = runBlocked(async () => fs.rmSync(linkedWork), {
            runtime: 'v2',
            projectRoot: configuredRoot,
        });
        await expect(removal).rejects.toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });
        const move = runBlocked(async () => fs.renameSync(linkedWork, movedLink), {
            runtime: 'v2',
            projectRoot: configuredRoot,
        });
        await expect(move).rejects.toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });

        const isStillLink = fs.lstatSync(linkedWork).isSymbolicLink();
        expect(isStillLink).toBe(true);
    });

    // The probe's lower-case spelling exists only on a case-insensitive volume, such as macOS's default.
    const isCaseInsensitive = (() => {
        const caseProbe = makeProbeDirOutsideTmp('DD-CASE-PROBE-');
        const lowerCaseName = path.basename(caseProbe).toLowerCase();
        const probeParent = path.dirname(caseProbe);
        const lowerCaseProbe = path.join(probeParent, lowerCaseName);
        const matches = fs.existsSync(lowerCaseProbe);
        fs.rmSync(caseProbe, { recursive: true, force: true });
        return matches;
    })();
    (isCaseInsensitive ? describe : describe.skip)('on a case-insensitive volume', () => {
        test('Should refuse removing or renaming the project root named in a different case', async () => {
            const differentCaseRoot = path.join(projectParent, 'PROJECT');
            const movedRoot = path.join(outsideDir, 'moved-project');

            const removal = runV2(async () =>
                fs.rmSync(differentCaseRoot, { recursive: true, force: true }),
            );
            await expect(removal).rejects.toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });
            const move = runV2(async () => fs.renameSync(differentCaseRoot, movedRoot));
            await expect(move).rejects.toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });

            const sourceContents = fs.readFileSync(sourceFile, 'utf8');
            expect(sourceContents).toBe(ORIGINAL_SOURCE);
        });

        test('Should refuse removing a symlinked parent on the configured path named in a different case', async () => {
            const realWork = path.join(outsideDir, 'real-work');
            const realApp = path.join(realWork, 'app');
            fs.mkdirSync(realApp, { recursive: true });
            const linkedWork = path.join(outsideDir, 'work');
            fs.symlinkSync(realWork, linkedWork);
            const configuredRoot = path.join(linkedWork, 'app');
            const differentCaseLink = path.join(outsideDir, 'WORK');

            const removal = runBlocked(async () => fs.rmSync(differentCaseLink), {
                runtime: 'v2',
                projectRoot: configuredRoot,
            });

            await expect(removal).rejects.toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });
            const isStillLink = fs.lstatSync(linkedWork).isSymbolicLink();
            expect(isStillLink).toBe(true);
        });
    });

    // macOS resolves /dev/fd/N to /dev/fd/<file name> rather than to the file the fd points to.
    test('Should refuse a v2 write through a /dev/fd path to an fd opened on a project file', async () => {
        const projectFd = fs.openSync(sourceFile, 'a');
        const fdPath = `/dev/fd/${projectFd}`;
        const expected =
            process.platform === 'darwin'
                ? UNCHECKABLE_PATH_BLOCKED_MESSAGE
                : PROJECT_WRITE_BLOCKED_MESSAGE;

        try {
            const run = runV2(async () => fs.writeFileSync(fdPath, 'overwritten'));
            await expect(run).rejects.toMatchObject({ message: expected });
        } finally {
            fs.closeSync(projectFd);
        }

        const sourceContents = fs.readFileSync(sourceFile, 'utf8');
        expect(sourceContents).toBe(ORIGINAL_SOURCE);
    });

    test('Should protect a project root that does not exist yet behind a symlinked parent', async () => {
        const realParent = path.join(outsideDir, 'real-parent');
        fs.mkdirSync(realParent);
        const linkedParent = path.join(outsideDir, 'linked-parent');
        fs.symlinkSync(realParent, linkedParent);
        const laterRoot = path.join(linkedParent, 'later-project');
        const realLaterSource = path.join(realParent, 'later-project', 'src');

        const run = runBlocked(async () => fs.mkdirSync(realLaterSource, { recursive: true }), {
            runtime: 'v2',
            projectRoot: laterRoot,
        });

        await expect(run).rejects.toMatchObject({ message: PROJECT_WRITE_BLOCKED_MESSAGE });
        const created = entryExists(realLaterSource);
        expect(created).toBe(false);
    });

    test('Should report an invalid file URL through the API it was passed to, not a synchronous throw', async () => {
        const invalidUrl = new URL('file:///tmp/a%2Fb');
        const outcome = await runV2(async () => {
            let syncError: unknown;
            let pending: Promise<unknown> | undefined;
            try {
                pending = fs.promises.writeFile(invalidUrl, 'x');
            } catch (err) {
                syncError = err;
            }
            const asyncError = await pending?.catch((err: unknown) => err);
            return { syncError, asyncError };
        });

        expect(outcome.syncError).toBeUndefined();
        expect(outcome.asyncError).toMatchObject({ message: UNCHECKABLE_PATH_BLOCKED_MESSAGE });
    });

    describe('a path object the guard cannot read', () => {
        // Shaped like a URL polyfill's instance, which Node's fs accepts as a file URL.
        function urlLike(target: string): unknown {
            const { href, protocol, hostname, pathname } = pathToFileURL(target);
            return { href, protocol, hostname, pathname, search: '', hash: '' };
        }
        function crossRealmBytes(target: string): unknown {
            const codes = [...Buffer.from(target)];
            return vm.runInNewContext('Uint8Array.from(codes)', { codes });
        }

        test.each<{ name: string; write: (target: unknown) => Promise<unknown> }>([
            {
                name: 'writeFileSync',
                write: async (target) => Reflect.apply(fs.writeFileSync, fs, [target, 'x']),
            },
            {
                name: 'fs.promises.writeFile',
                write: (target) => Reflect.apply(fs.promises.writeFile, fs.promises, [target, 'x']),
            },
            {
                name: 'openSync with a write flag',
                write: async (target) => Reflect.apply(fs.openSync, fs, [target, 'w']),
            },
            {
                name: 'fs.promises.open with a write flag',
                write: (target) => Reflect.apply(fs.promises.open, fs.promises, [target, 'w']),
            },
            {
                name: 'readFileSync with a write flag',
                write: async (target) =>
                    Reflect.apply(fs.readFileSync, fs, [target, { flag: 'w' }]),
            },
            {
                name: 'fs.promises.readFile with a write flag',
                write: (target) =>
                    Reflect.apply(fs.promises.readFile, fs.promises, [target, { flag: 'w' }]),
            },
        ])(
            'Should refuse a v2 run using $name on a URL-like object or bytes from another realm, saying the path cannot be checked',
            async ({ write }) => {
                const outsideTarget = path.join(outsideDir, 'cross-realm.txt');
                const targets = [urlLike(outsideTarget), crossRealmBytes(outsideTarget)];

                for (const target of targets) {
                    const run = runV2(() => write(target));
                    await expect(run).rejects.toMatchObject({
                        message: UNCHECKABLE_PATH_BLOCKED_MESSAGE,
                        code: 'EROFS',
                    });
                }

                const written = entryExists(outsideTarget);
                expect(written).toBe(false);
            },
        );

        test('Should refuse a URL-like object into the project the same way', async () => {
            const target = urlLike(sourceFile);

            const run = runV2(async () => Reflect.apply(fs.writeFileSync, fs, [target, 'x']));

            await expect(run).rejects.toMatchObject({ message: UNCHECKABLE_PATH_BLOCKED_MESSAGE });
            const sourceContents = fs.readFileSync(sourceFile, 'utf8');
            expect(sourceContents).toBe(ORIGINAL_SOURCE);
        });
    });
});
