// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/** Confirms known v1 limitations of in-process execution (vs. an isolated child process/thread) — not bugs to fix. */

import { mockLogger, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';
import { ROOT } from '@dd/tools/constants';
import { spawnSync } from 'child_process';
import path from 'path';
import { isDeepStrictEqual } from 'util';

import {
    func,
    PROCESS_EXIT_FIXTURE_CODE,
    stubExecuteAction,
    stubGetRuntimeContext,
} from './local-execution.fixtures';
import { executeScriptLocally } from './local-execution';

// Only a hang guard: a loaded full-suite run can slow the child Jest's startup far past its usual
// few seconds. spawnSync blocks the event loop, so this test's own Jest timeout can't fire first.
const SPAWN_TIMEOUT_MS = 60000;

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
    // `--runInBand` keeps it in the spawned process itself (not a worker) so its exit code surfaces here.
    // `--globalSetup` is a no-op: the real globalSetup.ts's `yarn install` + git setup serves the
    // fixtures directory this run never touches, and would only add startup time.
    test("Should confirm process.exit() inside the customer function crashes the whole process, bypassing runScriptLocally's own try/finally cleanup — known, real risk, not a safely-contained failure", () => {
        const fixturePath = path.join(__dirname, 'local-execution.process-exit.fixture.ts');
        const fixtureFilename = path.basename(fixturePath);
        const jestPackagePath = require.resolve('jest/package.json');
        const jestBinDir = path.dirname(jestPackagePath);
        const jestBinPath = path.join(jestBinDir, 'bin/jest.js');
        const jestConfigPath = path.resolve(ROOT, 'packages/tests/jest.config.ts');
        const noopGlobalSetupPath = path.resolve(
            ROOT,
            'packages/tests/src/_jest/noopGlobalSetup.ts',
        );

        const result = spawnSync(
            process.execPath,
            [
                jestBinPath,
                '--config',
                jestConfigPath,
                // jest-cli's --testMatch is a bare glob string (yargs `type: 'array'` collects one
                // occurrence per flag) — a JSON-stringified array is taken literally as a single
                // glob containing "[" and "]" characters and matches nothing.
                '--testMatch',
                `**/${fixtureFilename}`,
                '--globalSetup',
                noopGlobalSetupPath,
                '--runInBand',
            ],
            { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
        );

        const exit = { status: result.status, signal: result.signal };
        const expectedExit = { status: PROCESS_EXIT_FIXTURE_CODE, signal: null };
        if (!isDeepStrictEqual(exit, expectedExit)) {
            const exitText = JSON.stringify(exit);
            const spawnErrorText = result.error ? ` (${result.error.message})` : '';
            throw new Error(
                `Unexpected child exit ${exitText}${spawnErrorText}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
            );
        }
        expect(result.stdout).toContain('FIXTURE_STARTED');
        expect(result.stdout).not.toContain('FIXTURE_CLEANUP_RAN');
    });
});
