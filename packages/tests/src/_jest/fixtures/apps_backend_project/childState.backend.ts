// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

declare global {
    var childStateCalls: number | undefined;
}

let calls = 0;

export async function countCalls(delayMs = 0) {
    const startedAt = Date.now();
    calls += 1;
    globalThis.childStateCalls = (globalThis.childStateCalls ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { calls, globalCalls: globalThis.childStateCalls, pid: process.pid, startedAt, endedAt: Date.now() };
}

export async function waitForever() {
    await new Promise(() => {});
}

export function spinForever() {
    // eslint-disable-next-line no-empty
    for (;;) {}
}

export async function logLines(delayMs: number) {
    console.log('first line');
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    console.error('second line');
    process.stdout.write('no trailing newline');
    return 'logged';
}

export async function readEnvNames() {
    return Object.keys(process.env).sort();
}

export async function exitEarly() {
    process.exit(3);
}

export async function logOutOfMemoryAndExit() {
    console.error('retrying: heap out of memory upstream');
    process.exit(1);
}

export async function allocateUntilOutOfMemory() {
    const chunks: string[][] = [];
    for (;;) {
        chunks.push(new Array(1_000_000).fill('x'));
    }
}

export async function silenceStdout() {
    process.stdout.write = () => true;
    return 'quiet';
}

export async function readWorkingDirectory() {
    return { cwd: process.cwd(), cwdIsTmpdir: process.cwd() === process.env.TMPDIR };
}
