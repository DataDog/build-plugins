// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ActionCallArgs } from '@dd/apps-plugin/vite/local-execution-shared';
import { validateActionCallShape } from '@dd/apps-plugin/vite/local-execution-shared';

const actionDescription = '$.Actions.http.request';

describe('local-execution-shared — validateActionCallShape', () => {
    const rejected: Array<{ description: string; call: Partial<ActionCallArgs>; error: string }> = [
        {
            description: 'reject a call with no inputs',
            call: {},
            error: `Action ${actionDescription} must have an inputs field`,
        },
        {
            description: 'reject null inputs',
            call: { inputs: null as unknown as Record<string, unknown> },
            error: `Action ${actionDescription} must have an inputs field`,
        },
        {
            description: 'reject non-object inputs',
            call: { inputs: 'url' as unknown as Record<string, unknown> },
            error: `Action ${actionDescription} must have an inputs field`,
        },
        {
            description: 'reject inputs that declare their own allowedConnectionIds',
            call: { inputs: { url: 'https://example.com', allowedConnectionIds: ['conn-a'] } },
            error: `Action ${actionDescription} must not declare its own allowedConnectionIds in inputs`,
        },
        {
            description: 'reject inputs that declare an empty allowedConnectionIds',
            call: { inputs: { allowedConnectionIds: [] }, connectionId: 'conn-a' },
            error: `Action ${actionDescription} must not declare its own allowedConnectionIds in inputs`,
        },
    ];

    test.each(rejected)('Should $description', ({ call, error }) => {
        expect(() => validateActionCallShape(call, actionDescription)).toThrow(error);
    });

    const accepted: Array<{ description: string; call: Partial<ActionCallArgs> }> = [
        {
            description: 'return a call with a connectionId unchanged',
            call: { inputs: { url: 'https://example.com' }, connectionId: 'conn-a' },
        },
        {
            description: 'return a call without a connectionId unchanged',
            call: { inputs: { url: 'https://example.com' } },
        },
        {
            description: 'accept a connectionId outside any allowlist, leaving that to the caller',
            call: { inputs: {}, connectionId: 'not-in-any-allowlist' },
        },
        {
            description: 'accept allowedConnectionIds inherited from a prototype',
            call: { inputs: Object.create({ allowedConnectionIds: ['conn-a'] }) },
        },
    ];

    test.each(accepted)('Should $description', ({ call }) => {
        const validated = validateActionCallShape(call, actionDescription);

        expect(validated.inputs).toBe(call.inputs);
        expect(validated.connectionId).toBe(call.connectionId);
    });
});
