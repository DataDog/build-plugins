// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';
import { runnerImport } from 'vite';

export type FixtureConnectionLabels =
    typeof import('../fixtures/action_catalog_project/connection-labels.js');

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/action_catalog_project');

// Jest can't require the fixture's ESM, so it loads the way the plugin loads the real helper.
export const importFixtureConnectionLabels = async (): Promise<FixtureConnectionLabels> => {
    const { module } = await runnerImport<FixtureConnectionLabels>(
        path.join(FIXTURE_DIR, 'connection-labels.js'),
        { root: FIXTURE_DIR, logLevel: 'silent' },
    );
    return module;
};
