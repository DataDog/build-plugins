// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';

import type { BackendFunction } from '../backend/discovery';
import { encodeQueryName } from '../backend/encodeQueryName';

const log = getMockLogger();

const functions: BackendFunction[] = [
    {
        path: 'src/backend/myHandler',
        name: 'myHandler',
        entryPath: '/src/backend/myHandler.backend.ts',
    },
    {
        path: 'src/backend/otherFunc',
        name: 'otherFunc',
        entryPath: '/src/backend/otherFunc.backend.ts',
    },
];

const bundleName1 = encodeQueryName(functions[0]);
const bundleName2 = encodeQueryName(functions[1]);

const mockViteBuild = jest.fn().mockResolvedValue({
    output: [
        { type: 'chunk', isEntry: true, name: bundleName1, fileName: `${bundleName1}.js` },
        { type: 'chunk', isEntry: true, name: bundleName2, fileName: `${bundleName2}.js` },
    ],
});
const mockHandleUpload = jest.fn().mockResolvedValue(undefined);

const defaultOptions = {
    viteBuild: mockViteBuild,
    buildRoot: '/build',
    getBackendFunctions: () => functions,
    backendOutputs: new Map<string, string>(),
    handleUpload: mockHandleUpload,
    log,
    auth: { site: 'datadoghq.com' },
    hasBackend: true,
};

describe('Backend Functions - getVitePlugin', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        mockViteBuild.mockClear();
        mockHandleUpload.mockClear();
        defaultOptions.backendOutputs.clear();
    });

    test('Should return a vite plugin object with closeBundle', () => {
        const plugin = getVitePlugin(defaultOptions);
        expect(plugin).toBeDefined();
        expect(plugin!.closeBundle).toEqual(expect.any(Function));
    });

    test('Should build backend functions and then upload in closeBundle', async () => {
        const plugin = getVitePlugin(defaultOptions);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (plugin as any).closeBundle();

        expect(mockViteBuild).toHaveBeenCalledTimes(2);
        expect(defaultOptions.backendOutputs.size).toBe(2);
        expect(defaultOptions.backendOutputs.has(bundleName1)).toBe(true);
        expect(defaultOptions.backendOutputs.has(bundleName2)).toBe(true);
        // Upload should be called after build completes.
        expect(mockHandleUpload).toHaveBeenCalledTimes(1);
    });
});
