// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
// Not named `*.test.*` so `yarn test:unit` skips it — resilience.test.ts spawns it as its own Jest
// process instead, since process.exit() here would otherwise kill the parent worker. The disables
// below exist because Jest treats it as a test at runtime despite the eslint override not matching.
// eslint-disable-next-line import/no-extraneous-dependencies -- test-only helper; file isn't named *.test.ts
import { mockLogger, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';

import { func, stubExecuteAction } from './local-execution.fixtures';
import type { GetRuntimeContext } from './local-execution';
import { executeScriptLocally } from './local-execution';

const stubGetRuntimeContext: GetRuntimeContext = async () => ({
    Source: {
        initiator: { id: 'preview-initiator', orgId: 'preview-org' },
        runAsUser: { id: 'preview-run-as', orgId: 'preview-org' },
    },
});

// eslint-disable-next-line no-undef -- Jest injects `test` at runtime; eslint override doesn't match this filename
test('process.exit fixture', async () => {
    // Jest's console.log is buffered in-process and only flushed once a test result is reported —
    // process.exit() never lets that happen, so the marker must go straight to the real stdout fd.
    process.stdout.write('FIXTURE_STARTED\n');
    await executeScriptLocally(
        func,
        '/project',
        [],
        stubExecuteAction,
        stubGetRuntimeContext,
        moduleResolverFor(func, {
            example: () => {
                process.exit(7);
            },
        }),
        mockLogger,
        5000,
    );
    // Unreachable if process.exit() truly bypasses cleanup; see note above for why this bypasses console.log.
    process.stdout.write('FIXTURE_CLEANUP_RAN\n');
});
