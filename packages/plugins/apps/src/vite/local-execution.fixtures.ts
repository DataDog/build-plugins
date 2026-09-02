// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Not named `*.test.*` so `yarn test:unit`'s testMatch never picks it up as its own suite —
// shared by local-execution.test.ts, local-execution.resilience.test.ts, and
// local-execution.process-exit.fixture.ts, including the fixture despite it running as its own
// spawned Jest process: that spawn only isolates the OS process process.exit() can safely kill,
// not module resolution, so importing shared fixture data here works the same as it already does
// for mockLogger/moduleResolverFor.

import type { BackendFunction } from '../backend/types';

import type { ExecuteAction } from './local-execution';

export const func: BackendFunction = {
    relativePath: 'src/example',
    name: 'example',
    absolutePath: '/src/example.backend.ts',
    allowedConnectionIds: [],
};

export const stubExecuteAction: ExecuteAction = async (fqn) => ({ data: null, stub: true, fqn });
