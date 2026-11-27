// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';

export interface WorkerBootstrapData<TInit> {
    pnpPath?: string;
    issuerPath: string;
    initData: TInit;
}

export interface WorkerRequestMessage<TTask> {
    taskId: number;
    payload: TTask;
}

export type WorkerResponseMessage<TResult> =
    | {
          taskId: number;
          ok: true;
          result: TResult;
      }
    | {
          taskId: number;
          ok: false;
          error: {
              message: string;
              stack?: string;
              name?: string;
          };
      };

interface PendingTask<TTask, TResult> {
    taskId: number;
    payload: TTask;
    resolve: (result: TResult) => void;
    reject: (error: Error) => void;
}

interface WorkerSlot<TTask, TResult> {
    worker: Worker;
    inFlight: Map<number, PendingTask<TTask, TResult>>;
    idleTimer: ReturnType<typeof setTimeout> | undefined;
    dead: boolean;
}

export interface TransformWorkerPoolOptions<TInit> {
    /** Absolute path to the compiled CJS worker entry script. */
    workerScriptPath: string;
    /** Module file path used as `createRequire` issuer inside workers (for PnP / peerDeps). */
    issuerPath: string;
    /** Static initialization payload sent once to each worker via `workerData`. */
    initData: TInit;
    /** Maximum number of worker threads to spawn. */
    size: number;
    /** Max concurrent tasks per worker (default: 1 for synchronous CPU transforms). */
    maxInFlightPerWorker?: number;
    /** Auto-terminate idle workers after this duration in ms (default: 3000). */
    idleTimeoutMs?: number;
}

const DEFAULT_MAX_IN_FLIGHT_PER_WORKER = 1;
const DEFAULT_IDLE_TIMEOUT_MS = 3_000;
const MAX_DEFAULT_WORKERS = 4;

function parseNonNegativeInt(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === '') {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Compute the default number of transform worker threads to use.
 *
 * - `DD_BUILD_PLUGIN_WORKERS=0` disables worker offloading (runs in-process).
 * - `DD_BUILD_PLUGIN_WORKERS=N` explicitly sets the pool size.
 * - Inside Jest (`JEST_WORKER_ID` set), defaults to 0 unless explicitly opted in.
 * - Otherwise respects `WORKERS` (CI container CPU budget) or `os.availableParallelism()`,
 *   using half the available CPUs capped at 4 to balance throughput, peak RSS, and bundler CPU.
 */
function getCgroupCpuQuota(): number | undefined {
    if (process.platform !== 'linux') {
        return undefined;
    }
    try {
        const raw = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf-8').trim();
        const [quotaStr, periodStr] = raw.split(/\s+/);
        if (!quotaStr || quotaStr === 'max' || !periodStr) {
            return undefined;
        }
        const quota = Number.parseInt(quotaStr, 10);
        const period = Number.parseInt(periodStr, 10);
        if (Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0) {
            return Math.max(1, Math.floor(quota / period));
        }
    } catch {
        // Ignore on non-cgroupv2 systems.
    }
    return undefined;
}

export function getTransformWorkerCount(): number {
    const explicit = parseNonNegativeInt(process.env.DD_BUILD_PLUGIN_WORKERS);
    if (explicit !== undefined) {
        return explicit;
    }

    if (process.env.JEST_WORKER_ID !== undefined) {
        return 0;
    }

    const availableCpus =
        typeof os.availableParallelism === 'function'
            ? os.availableParallelism()
            : os.cpus().length;
    const cpuBudget =
        parseNonNegativeInt(process.env.WORKERS) ||
        parseNonNegativeInt(process.env.KUBERNETES_CPU_LIMIT) ||
        getCgroupCpuQuota() ||
        availableCpus;
    if (cpuBudget <= 2) {
        return 0;
    }

    return Math.min(Math.max(2, Math.floor(cpuBudget / 2)), MAX_DEFAULT_WORKERS);
}

/**
 * Resolve a sibling worker script path to a real on-disk filesystem path.
 * Under Yarn PnP, `__dirname` may be a `.yarn/__virtual__/...` path that a freshly
 * spawned worker (starting before PnP setup) cannot open directly.
 */
export function resolveWorkerScript(
    dir: string,
    filename: string,
    issuerFilename: string,
): { workerScriptPath: string; pnpPath: string | undefined } | undefined {
    const rawPath = path.join(dir, filename);
    let pnpPath: string | undefined;
    let resolvedPath = rawPath;

    if ((process.versions as Record<string, string | undefined>).pnp) {
        try {
            const runtimeRequire = createRequire(issuerFilename);
            const pnpModuleName = 'pnpapi';
            pnpPath = runtimeRequire.resolve(pnpModuleName);
            const pnp = runtimeRequire(pnpPath) as {
                resolveVirtual?: (p: string) => string | null;
            };
            resolvedPath = pnp.resolveVirtual?.(rawPath) ?? rawPath;
        } catch {
            pnpPath = undefined;
        }
    }

    if (!fs.existsSync(resolvedPath)) {
        return undefined;
    }

    return { workerScriptPath: resolvedPath, pnpPath };
}

/**
 * Helper called at the top of a worker script to bootstrap Yarn PnP (when the host
 * runs under PnP) and return a `require` function bound to the parent plugin's issuer
 * path so dependencies and optional peer dependencies resolve identically.
 */
export type WorkerRequireFn = (id: string) => unknown;

export function bootstrapWorkerRequire(workerData: {
    pnpPath?: string;
    issuerPath?: string;
}): WorkerRequireFn {
    if (workerData.pnpPath && !(process.versions as Record<string, string | undefined>).pnp) {
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires, import/no-dynamic-require
        const pnp = require(workerData.pnpPath) as { setup?: () => void };
        if (typeof pnp.setup === 'function') {
            pnp.setup();
        }
    }

    if (workerData.issuerPath) {
        return createRequire(workerData.issuerPath);
    }

    return require;
}

export class TransformWorkerPool<TInit, TTask, TResult> {
    private readonly workerScriptPath: string;
    private readonly pnpPath: string | undefined;
    private readonly issuerPath: string;
    private readonly initData: TInit;
    private readonly size: number;
    private readonly maxInFlightPerWorker: number;
    private readonly idleTimeoutMs: number;

    private slots: WorkerSlot<TTask, TResult>[] = [];
    private queue: PendingTask<TTask, TResult>[] = [];
    private nextTaskId = 1;

    constructor(options: TransformWorkerPoolOptions<TInit> & { pnpPath?: string }) {
        if (!Number.isInteger(options.size) || options.size < 1) {
            throw new Error(
                `TransformWorkerPool size must be a positive integer, got ${options.size}`,
            );
        }
        this.workerScriptPath = options.workerScriptPath;
        this.pnpPath = options.pnpPath;
        this.issuerPath = options.issuerPath;
        this.initData = options.initData;
        this.size = options.size;
        this.maxInFlightPerWorker =
            options.maxInFlightPerWorker ?? DEFAULT_MAX_IN_FLIGHT_PER_WORKER;
        this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    }

    get activeWorkerCount(): number {
        return this.slots.length;
    }

    run(payload: TTask): Promise<TResult> {
        return new Promise<TResult>((resolve, reject) => {
            this.queue.push({
                taskId: this.nextTaskId++,
                payload,
                resolve,
                reject,
            });
            this.drainQueue();
        });
    }

    /**
     * Terminate all currently running worker threads and reject any remaining
     * in-flight/queued tasks. Calling `run()` again later (e.g., watch rebuilds)
     * will lazily spawn fresh workers.
     */
    async terminateAll(): Promise<void> {
        const queued = this.queue.splice(0, this.queue.length);
        for (const pending of queued) {
            pending.reject(new Error('TransformWorkerPool terminated'));
        }

        const slotsToClose = this.slots.splice(0, this.slots.length);
        await Promise.allSettled(
            slotsToClose.map(async (slot) => {
                slot.dead = true;
                if (slot.idleTimer) {
                    clearTimeout(slot.idleTimer);
                    slot.idleTimer = undefined;
                }
                for (const pending of slot.inFlight.values()) {
                    pending.reject(new Error('TransformWorkerPool terminated'));
                }
                slot.inFlight.clear();
                await slot.worker.terminate();
            }),
        );
    }

    private drainQueue(): void {
        while (this.queue.length > 0) {
            const slot = this.findAvailableSlot();
            if (!slot) {
                return;
            }
            const pending = this.queue.shift()!;
            this.dispatchToSlot(slot, pending);
        }
    }

    private findAvailableSlot(): WorkerSlot<TTask, TResult> | undefined {
        let best: WorkerSlot<TTask, TResult> | undefined;
        for (const slot of this.slots) {
            if (slot.dead) {
                continue;
            }
            if (slot.inFlight.size === 0) {
                return slot;
            }
            if (
                slot.inFlight.size < this.maxInFlightPerWorker &&
                (!best || slot.inFlight.size < best.inFlight.size)
            ) {
                best = slot;
            }
        }

        if (this.slots.length < this.size) {
            return this.spawnSlot();
        }

        return best;
    }

    private spawnSlot(): WorkerSlot<TTask, TResult> {
        // Strip NODE_OPTIONS so worker threads don't inherit host preloaders,
        // profilers, or ts-node hooks. Yarn PnP (if active) is bootstrapped
        // explicitly inside the worker via `workerData.pnpPath`.
        const workerEnv = { ...process.env };
        delete workerEnv.NODE_OPTIONS;

        const workerData: WorkerBootstrapData<TInit> = {
            pnpPath: this.pnpPath,
            issuerPath: this.issuerPath,
            initData: this.initData,
        };

        const worker = new Worker(this.workerScriptPath, {
            workerData,
            execArgv: [],
            env: workerEnv,
        });

        const slot: WorkerSlot<TTask, TResult> = {
            worker,
            inFlight: new Map(),
            idleTimer: undefined,
            dead: false,
        };

        worker.on('message', (msg: WorkerResponseMessage<TResult>) => {
            const pending = slot.inFlight.get(msg.taskId);
            if (!pending) {
                return;
            }
            slot.inFlight.delete(msg.taskId);

            if (msg.ok) {
                pending.resolve(msg.result);
            } else {
                const err = new Error(msg.error.message);
                if (msg.error.name) {
                    err.name = msg.error.name;
                }
                if (msg.error.stack) {
                    err.stack = msg.error.stack;
                }
                pending.reject(err);
            }

            if (slot.inFlight.size === 0) {
                this.markSlotIdle(slot);
            }
            this.drainQueue();
        });

        worker.on('error', (error) => {
            this.handleSlotFailure(slot, error);
        });

        worker.on('exit', (code) => {
            if (!slot.dead) {
                this.handleSlotFailure(
                    slot,
                    new Error(`Transform worker exited unexpectedly with code ${code}`),
                );
            }
        });

        this.slots.push(slot);
        return slot;
    }

    private dispatchToSlot(
        slot: WorkerSlot<TTask, TResult>,
        pending: PendingTask<TTask, TResult>,
    ): void {
        if (slot.idleTimer) {
            clearTimeout(slot.idleTimer);
            slot.idleTimer = undefined;
        }
        if (slot.inFlight.size === 0) {
            slot.worker.ref();
        }
        slot.inFlight.set(pending.taskId, pending);
        const msg: WorkerRequestMessage<TTask> = {
            taskId: pending.taskId,
            payload: pending.payload,
        };
        slot.worker.postMessage(msg);
    }

    private markSlotIdle(slot: WorkerSlot<TTask, TResult>): void {
        if (slot.dead) {
            return;
        }
        slot.worker.unref();
        if (this.idleTimeoutMs > 0) {
            slot.idleTimer = setTimeout(() => {
                if (slot.dead || slot.inFlight.size > 0) {
                    return;
                }
                this.removeSlot(slot);
                slot.worker.terminate().catch(() => {});
            }, this.idleTimeoutMs);
            slot.idleTimer.unref();
        }
    }

    private handleSlotFailure(slot: WorkerSlot<TTask, TResult>, error: Error): void {
        if (slot.dead) {
            return;
        }
        this.removeSlot(slot);
        for (const pending of slot.inFlight.values()) {
            pending.reject(error);
        }
        slot.inFlight.clear();
        slot.worker.terminate().catch(() => {});
        this.drainQueue();
    }

    private removeSlot(slot: WorkerSlot<TTask, TResult>): void {
        slot.dead = true;
        if (slot.idleTimer) {
            clearTimeout(slot.idleTimer);
            slot.idleTimer = undefined;
        }
        const idx = this.slots.indexOf(slot);
        if (idx !== -1) {
            this.slots.splice(idx, 1);
        }
    }
}
