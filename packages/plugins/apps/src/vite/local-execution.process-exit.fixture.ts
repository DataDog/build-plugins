// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Not named `*.test.*` so `yarn test:unit` skips it — resilience.test.ts spawns it as its own Jest
// process instead, since process.exit() here would otherwise kill the parent worker. Jest still
// treats it as a test at runtime, so the eslint-disables below cover rules whose overrides key off
// the filename and don't apply here.

// eslint-disable-next-line import/no-extraneous-dependencies -- test-only helper
import { mockLogger, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs';

import { func, stubExecuteAction, stubGetRuntimeContext } from './local-execution.fixtures';
import { executeScriptLocally } from './local-execution';

// eslint-disable-next-line no-undef -- Jest injects `test` at runtime
test('process.exit fixture', async () => {
    // Jest's console.log is buffered in-process and only flushed once a test result is reported —
    // process.exit() never lets that happen, so the marker must go straight to the real stdout fd.
    // `process.stdout.write` itself is asynchronous when stdout is a pipe (spawnSync's default) on
    // POSIX, so process.exit() could still race ahead of it — fs.writeSync bypasses that entirely.
    fs.writeSync(1, 'FIXTURE_STARTED\n');
    const resolveModule = moduleResolverFor(func, {
        example: () => {
            process.exit(7);
        },
    });
    await executeScriptLocally(
        func,
        '/project',
        [],
        stubExecuteAction,
        stubGetRuntimeContext,
        resolveModule,
        mockLogger,
        5000,
    );
    // Unreachable if process.exit() truly bypasses cleanup; see note above for why this bypasses console.log.
    fs.writeSync(1, 'FIXTURE_CLEANUP_RAN\n');
});
