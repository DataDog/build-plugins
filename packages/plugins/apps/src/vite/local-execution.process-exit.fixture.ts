// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Deliberately not named `*.test.*` so `yarn test:unit`'s normal testMatch never picks it up —
// local-execution.resilience.test.ts spawns it as its own Jest process (via --testMatch override)
// to observe a real process.exit() call inside the actual executeScriptLocally() code path; running
// it in-process would kill the parent test's own Jest worker. Not matched by the repo's `**/*.test.ts`
// eslint override for the same reason, hence the disables below (Jest still injects the `test`
// global at runtime for any file it executes, matched or not).

// eslint-disable-next-line import/no-extraneous-dependencies -- test-only helper, same as any *.test.ts file; this file just isn't named like one (see note above)
import { mockLogger, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';

import type { BackendFunction } from '../backend/types';

import type { ExecuteAction, GetRuntimeContext } from './local-execution';
import { executeScriptLocally } from './local-execution';

const func: BackendFunction = {
    relativePath: 'src/example',
    name: 'example',
    absolutePath: '/src/example.backend.ts',
    allowedConnectionIds: [],
};

const stubExecuteAction: ExecuteAction = async (fqn) => ({ data: null, stub: true, fqn });

const stubGetRuntimeContext: GetRuntimeContext = async () => ({
    Source: {
        initiator: { id: 'preview-initiator', orgId: 'preview-org' },
        runAsUser: { id: 'preview-run-as', orgId: 'preview-org' },
    },
});

// eslint-disable-next-line no-undef -- Jest injects this global at runtime; not declared here because this file isn't matched by the repo's jest eslint override (see note above)
test('process.exit fixture', async () => {
    // eslint-disable-next-line no-console -- this file's stdout is the only channel the spawning parent test can observe
    console.log('FIXTURE_STARTED');
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
    // eslint-disable-next-line no-console -- see note above; unreachable if process.exit() truly bypasses cleanup
    console.log('FIXTURE_CLEANUP_RAN');
});
