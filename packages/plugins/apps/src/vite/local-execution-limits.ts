// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const DEV_VERIFY = '`dev:verify` (`npx datadog-apps dev --verify`)';
const LIMITS_DOC =
    'Rules: https://github.com/DataDog/build-plugins/tree/master/packages/plugins/apps#local-execution';
const LOCALLY = 'is blocked when running backend functions locally.';
const SUFFIX = `It may work in production; run ${DEV_VERIFY} to check it on the real runtime. ${LIMITS_DOC}`;
export const SUBPROCESS_BLOCKED_MESSAGE = `Spawning a subprocess ${LOCALLY} ${SUFFIX}`;
export const WORKER_THREAD_BLOCKED_MESSAGE = `Starting a worker thread ${LOCALLY} ${SUFFIX}`;
export const OUTSIDE_TEMP_WRITE_BLOCKED_MESSAGE = `Writing outside the call's temp dirs ${LOCALLY} ${SUFFIX}`;
export const OUTSIDE_READ_BLOCKED_MESSAGE = `Reading outside the folders a call can read ${LOCALLY} ${SUFFIX}`;
export const NATIVE_ADDON_BLOCKED_MESSAGE = `Loading a native addon ${LOCALLY} ${SUFFIX}`;
export const PERMISSION_BLOCKED_MESSAGE = `This operation ${LOCALLY} ${SUFFIX}`;
export const UNRESTRICTED_LOCAL_EXECUTION_WARNING = `Backend functions run locally without Node's permission model, so production's limits aren't enforced; ${DEV_VERIFY} runs them on the real runtime. ${LIMITS_DOC}`;

const NODE_PERMISSION_SCOPES = new Set([
    'FileSystemRead',
    'FileSystemWrite',
    'ChildProcess',
    'WorkerThreads',
    'Inspector',
    'WASI',
    'Net',
    'Addons',
]);
const PERMISSION_REFUSAL_MESSAGES = new Map([
    ['ChildProcess', SUBPROCESS_BLOCKED_MESSAGE],
    ['WorkerThreads', WORKER_THREAD_BLOCKED_MESSAGE],
    ['FileSystemWrite', OUTSIDE_TEMP_WRITE_BLOCKED_MESSAGE],
    ['FileSystemRead', OUTSIDE_READ_BLOCKED_MESSAGE],
]);

function permissionRefusalMessage(error: Error): string | undefined {
    const code = 'code' in error ? error.code : undefined;
    if (code === 'ERR_DLOPEN_DISABLED') {
        return NATIVE_ADDON_BLOCKED_MESSAGE;
    }
    // Node's refusals always carry one of its permission scopes; any other error is the function's own.
    if (code !== 'ERR_ACCESS_DENIED' || !('permission' in error)) {
        return undefined;
    }
    const permission = String(error.permission);
    if (!NODE_PERMISSION_SCOPES.has(permission)) {
        return undefined;
    }
    const message = PERMISSION_REFUSAL_MESSAGES.get(permission) ?? PERMISSION_BLOCKED_MESSAGE;
    const resource = 'resource' in error ? error.resource : undefined;
    const isPath = permission.startsWith('FileSystem');
    return isPath && typeof resource === 'string' && resource
        ? `${message} Refused: ${resource}`
        : message;
}

// Node's own refusal suggests a permission flag, which the developer can't pass to a call's process.
// The refused call's frames stay, so the reported stack still points at the code that made it.
export function withPermissionHint(error: unknown): unknown {
    // Only the permission model raises these codes; without it, a matching error is the function's own.
    if (!process.permission) {
        return error;
    }
    try {
        const hint = error instanceof Error ? permissionRefusalMessage(error) : undefined;
        if (!(error instanceof Error) || hint === undefined) {
            return error;
        }
        const hinted = new Error(hint);
        const lines = typeof error.stack === 'string' ? error.stack.split('\n') : [];
        const frames = lines.filter((line) => line.startsWith('    at '));
        hinted.stack = [`Error: ${hint}`, ...frames].join('\n');
        return hinted;
    } catch {
        return error;
    }
}
