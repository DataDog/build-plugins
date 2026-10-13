// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Config } from '@jest/types';
import fs from 'fs';
import path from 'path';

import { GATE_FILE_NAME, LEAKED_REQUESTS, pollUntil } from './nockLeakShared';

const MAX_WAIT_MS = 10000;

// The `--globalTeardown` for nockLeak.fixture.ts. It runs after the fixture file's own teardown:
// releases the requests the fixture left in flight, then waits until they have settled.
const nockLeakTeardown = async (
    globalConfig: Config.GlobalConfig,
    projectConfig: Config.ProjectConfig,
) => {
    const leakDir = projectConfig.globals.NOCK_LEAK_DIR;
    if (typeof leakDir !== 'string') {
        throw new Error('The NOCK_LEAK_DIR global is required.');
    }
    const gatePath = path.join(leakDir, GATE_FILE_NAME);
    fs.writeFileSync(gatePath, 'open');

    const markerPaths = LEAKED_REQUESTS.map((name) => path.join(leakDir, name));
    const deadline = Date.now() + MAX_WAIT_MS;
    await pollUntil(() => markerPaths.every((markerPath) => fs.existsSync(markerPath)), deadline);
};

export default nockLeakTeardown;
