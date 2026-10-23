// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    NATIVE_ADDON_BLOCKED_MESSAGE,
    OUTSIDE_READ_BLOCKED_MESSAGE,
    OUTSIDE_TEMP_WRITE_BLOCKED_MESSAGE,
    PERMISSION_BLOCKED_MESSAGE,
    SUBPROCESS_BLOCKED_MESSAGE,
    WORKER_THREAD_BLOCKED_MESSAGE,
    withPermissionHint,
} from './local-execution-limits';

const refusal = (fields: Record<string, unknown>) =>
    Object.assign(new Error('Access to this API has been restricted'), fields);

describe('withPermissionHint', () => {
    const realPermission = Object.getOwnPropertyDescriptor(process, 'permission');

    beforeEach(() => {
        Object.defineProperty(process, 'permission', {
            value: { has: () => false },
            configurable: true,
        });
    });

    afterEach(() => {
        if (realPermission) {
            Object.defineProperty(process, 'permission', realPermission);
        } else {
            Reflect.deleteProperty(process, 'permission');
        }
    });

    test.each([
        {
            refused: 'a subprocess',
            fields: { code: 'ERR_ACCESS_DENIED', permission: 'ChildProcess', resource: 'echo' },
            message: SUBPROCESS_BLOCKED_MESSAGE,
        },
        {
            refused: 'a worker thread, whose resource is empty',
            fields: { code: 'ERR_ACCESS_DENIED', permission: 'WorkerThreads', resource: '' },
            message: WORKER_THREAD_BLOCKED_MESSAGE,
        },
        {
            refused: 'a write, naming its path',
            fields: { code: 'ERR_ACCESS_DENIED', permission: 'FileSystemWrite', resource: '/x' },
            message: `${OUTSIDE_TEMP_WRITE_BLOCKED_MESSAGE} Refused: /x`,
        },
        {
            refused: 'a read, naming its path',
            fields: { code: 'ERR_ACCESS_DENIED', permission: 'FileSystemRead', resource: '/y' },
            message: `${OUTSIDE_READ_BLOCKED_MESSAGE} Refused: /y`,
        },
        {
            refused: 'another permission',
            fields: {
                code: 'ERR_ACCESS_DENIED',
                permission: 'Inspector',
                resource: 'StartIoThread',
            },
            message: PERMISSION_BLOCKED_MESSAGE,
        },
        {
            refused: 'a native addon',
            fields: { code: 'ERR_DLOPEN_DISABLED' },
            message: NATIVE_ADDON_BLOCKED_MESSAGE,
        },
    ])('Should hint at dev:verify for $refused', ({ fields, message }) => {
        const original = refusal(fields);
        const hinted = withPermissionHint(original);

        expect(hinted).toBeInstanceOf(Error);
        expect(hinted).toMatchObject({ message });
        expect(hinted).toHaveProperty(
            'stack',
            expect.stringContaining(`Error: ${message}\n    at `),
        );
    });

    const throwingCode = new Error('custom');
    Object.defineProperty(throwingCode, 'code', {
        get() {
            throw new Error('getter');
        },
    });

    test.each([
        {
            kind: 'an ERR_ACCESS_DENIED without a permission',
            error: refusal({ code: 'ERR_ACCESS_DENIED' }),
        },
        { kind: 'an unrelated error', error: new Error('boom') },
        {
            kind: "an ERR_ACCESS_DENIED with a scope that isn't Node's",
            error: refusal({ code: 'ERR_ACCESS_DENIED', permission: 'read:users' }),
        },
        { kind: 'a thrown string', error: 'boom' },
        { kind: 'an error whose code getter throws', error: throwingCode },
    ])('Should keep $kind as it is', ({ error }) => {
        const result = withPermissionHint(error);

        expect(result).toBe(error);
    });

    test('Should keep a refusal as it is without the permission model', () => {
        Reflect.deleteProperty(process, 'permission');
        const original = refusal({ code: 'ERR_ACCESS_DENIED', permission: 'ChildProcess' });

        const result = withPermissionHint(original);

        expect(result).toBe(original);
    });
});
