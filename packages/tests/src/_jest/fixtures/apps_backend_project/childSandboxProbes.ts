// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

function attempt(run: () => string): string {
    try {
        return `ok: ${run()}`;
    } catch (error) {
        if (!(error instanceof Error)) {
            return `refused: ${String(error)}`;
        }
        const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        return `refused: ${code ?? error.message}`;
    }
}

export async function probeSandbox(projectFile: string, fetchUrl: string, sharedTmpFile: string) {
    const tempFile = path.join(os.tmpdir(), 'sandbox-probe.txt');
    const result: Record<string, string> = {
        sharedTmpWrite: attempt(() => {
            fs.writeFileSync(sharedTmpFile, 'x');
            return 'written';
        }),
        projectWrite: attempt(() => {
            fs.writeFileSync(projectFile, 'x');
            return 'written';
        }),
        tempWrite: attempt(() => {
            fs.writeFileSync(tempFile, 'x');
            return fs.readFileSync(tempFile, 'utf-8');
        }),
        spawn: attempt(() => {
            const spawned = spawnSync('echo', ['hi']);
            if (spawned.error) {
                throw spawned.error;
            }
            return String(spawned.stdout);
        }),
        worker: attempt(() => {
            const worker = new Worker('setTimeout(() => {}, 10)', { eval: true });
            worker.terminate();
            return 'started';
        }),
    };
    try {
        const response = await fetch(fetchUrl);
        result.fetch = `ok: ${response.status} ${await response.text()}`;
    } catch (error) {
        result.fetch = `refused: ${error instanceof Error ? error.message : String(error)}`;
    }
    return result;
}

// Asks the dev server for a module straight over the IPC channel, skipping the module runner.
export function forgeInvoke(url: string, importer?: string) {
    const id = 999_998;
    return new Promise((resolve) => {
        process.on('message', (message: { type?: string; id?: number; response?: unknown }) => {
            if (message?.type === 'invoke-result' && message.id === id) {
                resolve(message.response);
            }
        });
        process.send?.({
            type: 'invoke',
            id,
            payload: { type: 'custom', event: 'vite:invoke', data: { id: 'send', name: 'fetchModule', data: [url, importer, {}] } },
        });
    });
}
