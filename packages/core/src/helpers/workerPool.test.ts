// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { TransformWorkerPool, getTransformWorkerCount, resolveWorkerScript } from './workerPool';

describe('TransformWorkerPool', () => {
    const savedEnv: Record<string, string | undefined> = {
        DD_BUILD_PLUGIN_WORKERS: process.env.DD_BUILD_PLUGIN_WORKERS,
        JEST_WORKER_ID: process.env.JEST_WORKER_ID,
        WORKERS: process.env.WORKERS,
    };
    let tempDir = '';
    let workerPath = '';

    beforeAll(() => {
        tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-worker-pool-')));
        workerPath = path.join(tempDir, 'echo-worker.js');
        fs.writeFileSync(
            workerPath,
            `
            const { parentPort, workerData } = require('worker_threads');
            parentPort.on('message', ({ taskId, payload }) => {
                if (payload.fail) {
                    parentPort.postMessage({
                        taskId,
                        ok: false,
                        error: { message: 'boom: ' + payload.value, name: 'TransformError' },
                    });
                    return;
                }
                parentPort.postMessage({
                    taskId,
                    ok: true,
                    result: workerData.initData.prefix + payload.value,
                });
            });
            `,
        );
    });

    afterEach(() => {
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = val;
            }
        }
    });

    afterAll(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('processes tasks in parallel across worker threads and terminates cleanly', async () => {
        const pool = new TransformWorkerPool<
            { prefix: string },
            { value: number; fail?: boolean },
            string
        >({
            workerScriptPath: workerPath,
            issuerPath: __filename,
            initData: { prefix: 'ok:' },
            size: 2,
            idleTimeoutMs: 5_000,
        });

        try {
            const results = await Promise.all([
                pool.run({ value: 1 }),
                pool.run({ value: 2 }),
                pool.run({ value: 3 }),
                pool.run({ value: 4 }),
            ]);
            expect(results).toEqual(['ok:1', 'ok:2', 'ok:3', 'ok:4']);
            expect(pool.activeWorkerCount).toBe(2);
        } finally {
            await pool.terminateAll();
        }
        expect(pool.activeWorkerCount).toBe(0);
    });

    it('propagates worker task errors and stays healthy for subsequent tasks', async () => {
        const pool = new TransformWorkerPool<
            { prefix: string },
            { value: number; fail?: boolean },
            string
        >({
            workerScriptPath: workerPath,
            issuerPath: __filename,
            initData: { prefix: 'ok:' },
            size: 1,
        });

        try {
            await expect(pool.run({ value: 99, fail: true })).rejects.toMatchObject({
                name: 'TransformError',
                message: 'boom: 99',
            });
            await expect(pool.run({ value: 7 })).resolves.toBe('ok:7');
        } finally {
            await pool.terminateAll();
        }
    });

    it('auto-terminates idle workers and lazily respawns on next task', async () => {
        const pool = new TransformWorkerPool<{ prefix: string }, { value: number }, string>({
            workerScriptPath: workerPath,
            issuerPath: __filename,
            initData: { prefix: 'v:' },
            size: 1,
            idleTimeoutMs: 50,
        });

        try {
            await expect(pool.run({ value: 1 })).resolves.toBe('v:1');
            expect(pool.activeWorkerCount).toBe(1);

            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(pool.activeWorkerCount).toBe(0);

            await expect(pool.run({ value: 2 })).resolves.toBe('v:2');
            expect(pool.activeWorkerCount).toBe(1);
        } finally {
            await pool.terminateAll();
        }
    });

    it('respects DD_BUILD_PLUGIN_WORKERS, JEST_WORKER_ID, and WORKERS sizing rules', () => {
        process.env.DD_BUILD_PLUGIN_WORKERS = '0';
        expect(getTransformWorkerCount()).toBe(0);

        process.env.DD_BUILD_PLUGIN_WORKERS = '4';
        expect(getTransformWorkerCount()).toBe(4);

        delete process.env.DD_BUILD_PLUGIN_WORKERS;
        expect(getTransformWorkerCount()).toBe(0);

        delete process.env.JEST_WORKER_ID;
        process.env.WORKERS = '8';
        expect(getTransformWorkerCount()).toBe(4);

        process.env.WORKERS = '2';
        expect(getTransformWorkerCount()).toBe(0);

        process.env.WORKERS = '32';
        expect(getTransformWorkerCount()).toBe(4);
    });

    it('resolves existing worker scripts and returns undefined when missing', () => {
        expect(resolveWorkerScript(tempDir, 'echo-worker.js', __filename)).toEqual({
            workerScriptPath: workerPath,
            pnpPath: undefined,
        });
        expect(resolveWorkerScript(tempDir, 'missing-worker.js', __filename)).toBeUndefined();
    });
});
