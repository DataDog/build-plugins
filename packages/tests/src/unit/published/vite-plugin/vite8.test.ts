// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { execute } from '@dd/tools/helpers';
import { existsSync } from 'fs';
import path from 'path';

const PUBLISHED_VITE_PLUGIN_DIR = path.resolve(__dirname, '../../../../../published/vite-plugin');
const FIXTURE_DIR = path.resolve(__dirname, '../../../_jest/fixtures/vite_react_router_project');

// Building the plugin and a full Vite 8 project can take a while.
const TIMEOUT = 5 * 60 * 1000;

describe('Vite 8 support', () => {
    beforeAll(async () => {
        // The fixture links @datadog/vite-plugin and consumes its built `dist`,
        // so we need to ensure the plugin is built before running the Vite build.
        const distEntry = path.resolve(PUBLISHED_VITE_PLUGIN_DIR, 'dist/src/index.js');
        if (!existsSync(distEntry)) {
            await execute('yarn', ['build'], PUBLISHED_VITE_PLUGIN_DIR);
        }
    }, TIMEOUT);

    test(
        'should build a real Vite 8 + React Router project with the plugin',
        async () => {
            const { stdout, stderr } = await execute('yarn', ['build'], FIXTURE_DIR);
            const output = `${stdout}\n${stderr}`;

            // Confirms the build actually ran against Vite 8.
            expect(output).toContain('vite v8');

            // Confirms the Datadog plugin executed (it writes its output reports).
            expect(existsSync(path.resolve(FIXTURE_DIR, 'dist/build.json'))).toBe(true);

            // Confirms the project itself built.
            expect(existsSync(path.resolve(FIXTURE_DIR, 'build/client'))).toBe(true);
        },
        TIMEOUT,
    );
});
