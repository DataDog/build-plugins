// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/** Two targeted checks that empirically confirm real failure modes of running backend functions in-process rather than in an isolated child process/thread — accepted v1 limitations, not bugs this file fixes. */

import { mockLogger, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';
import { spawnSync } from 'child_process';
import path from 'path';

import type { BackendFunction } from '../backend/types';

import type { ExecuteAction } from './local-execution';
import { executeScriptLocally } from './local-execution';

const func: BackendFunction = {
    relativePath: 'src/example',
    name: 'example',
    absolutePath: '/src/example.backend.ts',
    allowedConnectionIds: [],
};

const stubExecuteAction: ExecuteAction = async (fqn) => ({ data: null, stub: true, fqn });

describe('local-execution resilience (in-process execution known limitations)', () => {
    // A real `while (true) {}` would hang this test (and the whole Jest
    // worker) forever, since nothing — including the timeout's own
    // setTimeout callback — can run while the event loop is synchronously
    // blocked. A bounded, time-boxed busy-wait demonstrates the exact same
    // mechanism without actually hanging: if the 20ms timeout could
    // interrupt a synchronous loop, this would settle around 20ms with a
    // timeout rejection; instead it can only settle once the loop itself
    // finishes on its own, ~200ms later, with the loop's real result.
    test('Should NOT interrupt a synchronous CPU-bound loop with the current timeout — known, accepted v1 limitation', async () => {
        const start = Date.now();

        const result = await executeScriptLocally(
            func,
            '/project',
            [],
            stubExecuteAction,
            moduleResolverFor(func, {
                example: () => {
                    const deadline = Date.now() + 200;
                    // eslint-disable-next-line no-empty
                    while (Date.now() < deadline) {}
                    return 'loop finished on its own';
                },
            }),
            mockLogger,
            20,
        );

        const elapsedMs = Date.now() - start;

        expect(result).toEqual({ data: 'loop finished on its own' });
        expect(elapsedMs).toBeGreaterThanOrEqual(150);
    });

    // process.exit() can't be run inside this same Jest process — it would
    // actually terminate the test runner. This spawns local-execution.process-exit.fixture.ts as its
    // own Jest process (real transform, real module resolution, real executeScriptLocally/
    // runScriptLocally code path — not a hand-rolled emulation of it) to test the relevant claim:
    // does the try/finally runScriptLocally wraps around the customer's function call offer any
    // protection against process.exit()? It doesn't — process.exit() is immediate and unconditional
    // at the OS level, so no JS-level exception handling in this in-process design can intercept it.
    // A customer function calling process.exit() takes the whole dev server down with it, not just
    // its own execution. `--runInBand` is required so the fixture runs in the spawned process itself
    // rather than a Jest worker — otherwise Jest would report a worker crash instead of surfacing
    // exit code 7 on the process this test observes.
    test("Should confirm process.exit() inside the customer function crashes the whole process, bypassing runScriptLocally's own try/finally cleanup — known, real risk, not a safely-contained failure", () => {
        const fixturePath = path.join(__dirname, 'local-execution.process-exit.fixture.ts');
        const jestBinPath = path.join(
            path.dirname(require.resolve('jest/package.json')),
            'bin/jest.js',
        );
        const jestConfigPath = path.join(__dirname, '../../../../tests/jest.config.ts');

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
                `**/${path.basename(fixturePath)}`,
                '--runInBand',
            ],
            { encoding: 'utf8', timeout: 30000 },
        );

        expect(result.status).toBe(7);
        expect(result.stdout).toContain('FIXTURE_STARTED');
        expect(result.stdout).not.toContain('FIXTURE_CLEANUP_RAN');
    }, 30000);
});
