// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Not named `*.test.*` so `yarn test:unit` doesn't run it as its own suite. Shared by all three
// local-execution test files, including the spawned-process fixture — spawning isolates the OS
// process, not module resolution, so this import works there too.

import type { BackendFunction } from '../backend/types';

import type { ExecuteAction } from './local-execution';

export const func: BackendFunction = {
    relativePath: 'src/example',
    name: 'example',
    absolutePath: '/src/example.backend.ts',
    allowedConnectionIds: [],
};

export const stubExecuteAction: ExecuteAction = async (fqn) => ({ data: null, stub: true, fqn });
