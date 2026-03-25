// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getBackendPlugin } from '@dd/apps-plugin/backend/index';
import type { BackendPluginOptions } from '@dd/apps-plugin/backend/index';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';

const log = getMockLogger();
const mockViteBuild = jest.fn();

const defaultOptions: BackendPluginOptions = {
    viteBuild: mockViteBuild,
    buildRoot: '/build',
    functions: [
        { name: 'myHandler', entryPath: '/src/backend/myHandler.ts' },
        { name: 'otherFunc', entryPath: '/src/backend/otherFunc/index.ts' },
    ],
    backendOutputs: new Map(),
    log,
};

describe('Backend Functions - getBackendPlugin', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    describe('plugin shape', () => {
        test('Should return a plugin with correct name and enforce', () => {
            const plugin = getBackendPlugin(defaultOptions);
            expect(plugin.name).toBe('datadog-apps-backend-plugin');
            expect(plugin.enforce).toBe('pre');
        });

        test('Should have a vite property', () => {
            const plugin = getBackendPlugin(defaultOptions);
            expect(plugin.vite).toBeDefined();
        });
    });
});
