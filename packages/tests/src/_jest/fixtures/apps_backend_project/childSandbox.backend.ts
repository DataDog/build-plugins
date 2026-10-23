// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { forgeInvoke, probeSandbox } from './childSandboxProbes';

export async function runSandboxProbes(
    projectFile: string,
    fetchUrl: string,
    sharedTmpFile: string,
) {
    return probeSandbox(projectFile, fetchUrl, sharedTmpFile);
}

export async function loadOverIpc(url: string, importer?: string) {
    return forgeInvoke(url, importer);
}

export async function writeFile(filePath: string) {
    fs.writeFileSync(filePath, 'x');
    return 'written';
}

export async function loadAddon(addonPath: string) {
    process.dlopen({ exports: {} }, addonPath);
    return 'loaded';
}

export async function spawnEcho() {
    const output = execFileSync('echo', ['hi']);
    return String(output);
}

export async function throwAccessDeniedLookalike() {
    throw Object.assign(new Error('upstream refused the request'), { code: 'ERR_ACCESS_DENIED' });
}
