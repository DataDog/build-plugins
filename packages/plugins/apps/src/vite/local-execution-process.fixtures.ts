// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';

let builtChildPath: Promise<string> | undefined;
let outDir: string | undefined;

// Jest runs the TypeScript sources, but the child process needs the plain ESM file the published build ships.
export function buildLocalExecutionChild(): Promise<string> {
    builtChildPath ??= (async () => {
        const tmpPrefix = path.join(os.tmpdir(), 'dd-apps-child-');
        outDir = fs.mkdtempSync(tmpPrefix);
        const outfile = path.join(outDir, 'local-execution-child.mjs');
        await build({
            entryPoints: [path.join(__dirname, 'local-execution-child.ts')],
            bundle: true,
            format: 'esm',
            platform: 'node',
            target: 'node20',
            outfile,
            logLevel: 'silent',
        });
        return outfile;
    })();
    return builtChildPath;
}

export function removeLocalExecutionChild(): void {
    if (outDir) {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    outDir = undefined;
    builtChildPath = undefined;
}

export const FIXTURE_ROOT = path.resolve(
    __dirname,
    '../../../../tests/src/_jest/fixtures/apps_backend_project',
);

export const previewRuntimeContext = {
    Source: {
        initiator: { id: 'preview-initiator', orgId: 'preview-org' },
        runAsUser: { id: 'preview-run-as', orgId: 'preview-org' },
    },
};
