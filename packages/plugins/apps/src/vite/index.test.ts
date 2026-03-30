// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';

const log = getMockLogger();
const mockViteBuild = jest.fn().mockResolvedValue({
    output: [
        { type: 'chunk', isEntry: true, name: 'myHandler', fileName: 'myHandler.js' },
        { type: 'chunk', isEntry: true, name: 'otherFunc', fileName: 'otherFunc.js' },
    ],
});
const mockHandleUpload = jest.fn().mockResolvedValue(undefined);

const defaultOptions = {
    viteBuild: mockViteBuild,
    buildRoot: '/build',
    functions: [
        { name: 'myHandler', entryPath: '/src/backend/myHandler.ts' },
        { name: 'otherFunc', entryPath: '/src/backend/otherFunc/index.ts' },
    ],
    backendOutputs: new Map(),
    handleUpload: mockHandleUpload,
    log,
    auth: { site: 'datadoghq.com' },
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

        expect(mockViteBuild).toHaveBeenCalledTimes(1);
        expect(defaultOptions.backendOutputs.size).toBe(2);
        expect(defaultOptions.backendOutputs.has('myHandler')).toBe(true);
        expect(defaultOptions.backendOutputs.has('otherFunc')).toBe(true);
        // Upload should be called after build completes.
        expect(mockHandleUpload).toHaveBeenCalledTimes(1);
    });
});
