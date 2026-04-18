// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Only the fetch (dev-server) transport is exercised here. The iframe
// postMessage transport requires a DOM (`window`, `MessageEvent`) that this
// repo's node-only jest harness doesn't provide — adding jsdom collides with
// the shared `setupAfterEnv.ts` (nock → TextEncoder). postMessage coverage
// lives with the original tests in web-ui's @datadog/apps-function-query
// until a DOM-enabled harness is introduced.

import { BackendFunctionError } from '../types';

import { devServerTransport } from './dev-server-transport';

describe('devServerTransport', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('should successfully execute a backend function', async () => {
        const mockResponse = { success: true, result: { data: { sum: 12 } } };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        const result = await devServerTransport<{ sum: number }>('testWithImport', [5, 7]);

        expect(result).toEqual({ sum: 12 });
        expect(global.fetch).toHaveBeenCalledWith('/__dd/executeAction', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                functionName: 'testWithImport',
                args: [5, 7],
            }),
        });
    });

    it('should throw BackendFunctionError on network error', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('Network failed'));

        await expect(devServerTransport('testFunction', [])).rejects.toThrow(BackendFunctionError);

        await expect(devServerTransport('testFunction', [])).rejects.toThrow(
            'Network error while executing backend function "testFunction"',
        );
    });

    it('should throw BackendFunctionError on non-ok response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error',
        });

        await expect(devServerTransport('testFunction', [])).rejects.toThrow(BackendFunctionError);

        await expect(devServerTransport('testFunction', [])).rejects.toThrow(
            'Backend function "testFunction" failed with status 500',
        );
    });

    it('should throw BackendFunctionError when response contains error field', async () => {
        const mockResponse = {
            error: 'Function execution failed',
            data: null,
        };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        await expect(devServerTransport('testFunction', [])).rejects.toThrow(BackendFunctionError);

        await expect(devServerTransport('testFunction', [])).rejects.toThrow(
            'Backend function "testFunction" returned an error',
        );
    });

    it('should throw BackendFunctionError on invalid JSON response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new Error('Invalid JSON');
            },
        });

        await expect(devServerTransport('testFunction', [])).rejects.toThrow(BackendFunctionError);

        await expect(devServerTransport('testFunction', [])).rejects.toThrow(
            'Failed to parse response from backend function',
        );
    });

    it('should include statusCode in error when available', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 404,
            text: async () => 'Not Found',
        });

        await expect(devServerTransport('testFunction', [])).rejects.toMatchObject({
            name: 'BackendFunctionError',
            functionName: 'testFunction',
            statusCode: 404,
        });
    });
});
