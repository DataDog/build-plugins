// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/** Confirms known v1 limitations of in-process execution (vs. an isolated child process/thread) — not bugs to fix. */

import { mockLogger, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';
import {
    FIXTURE_TEST_TIMEOUT_MS,
    spawnJestFixture,
} from '@dd/tests/_jest/helpers/spawnJestFixture';

import {
    func,
    PROCESS_EXIT_FIXTURE_CODE,
    stubExecuteAction,
    stubGetRuntimeContext,
} from './local-execution.fixtures';
import { executeScriptLocally } from './local-execution';

describe('local-execution resilience (in-process execution known limitations)', () => {
    // A real `while (true) {}` would hang this test forever, since nothing — not even the timeout's
    // own callback — can run while the event loop is blocked synchronously. This bounded busy-wait
    // proves the same point safely: the timeout can't interrupt it, so it settles once the loop ends.
    test('Should NOT interrupt a synchronous CPU-bound loop with the current timeout — known, accepted v1 limitation', async () => {
        const resolver = moduleResolverFor(func, {
            example: () => {
                const deadline = Date.now() + 800;
                // eslint-disable-next-line no-empty
                while (Date.now() < deadline) {}
                return 'loop finished on its own';
            },
        });

        const start = Date.now();

        const result = await executeScriptLocally(
            func,
            '/project',
            [],
            stubExecuteAction,
            stubGetRuntimeContext,
            resolver,
            mockLogger,
            300,
        );

        const elapsedMs = Date.now() - start;

        expect(result).toEqual({ data: 'loop finished on its own' });
        expect(elapsedMs).toBeGreaterThanOrEqual(700);
    });

    // process.exit() would kill this Jest process, so the fixture runs as its own real Jest process —
    // proving runScriptLocally's try/finally offers no protection, since exit() acts at the OS level.
    // The helper's default --runInBand keeps the fixture out of a worker, so its exit code surfaces.
    test(
        "Should confirm process.exit() inside the customer function crashes the whole process, bypassing runScriptLocally's own try/finally cleanup — known, real risk, not a safely-contained failure",
        () => {
            const run = spawnJestFixture('**/local-execution.process-exit.fixture.ts', [], {});

            // A signal kill leaves status null, so this also rules one out.
            if (run.status !== PROCESS_EXIT_FIXTURE_CODE) {
                throw new Error(`Unexpected child exit\n${run.output}`);
            }
            expect(run.stdout).toContain('FIXTURE_STARTED');
            expect(run.stdout).not.toContain('FIXTURE_CLEANUP_RAN');
        },
        FIXTURE_TEST_TIMEOUT_MS,
    );
});
