// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { getAuthenticatedRequest, MissingAuthenticationError } from '@dd/apps-plugin/auth';
import { doRequest } from '@dd/core/helpers/request';
import { cleanEnv } from '@dd/tests/_jest/helpers/env';

jest.mock('@dd/core/helpers/request', () => ({
    doRequest: jest.fn(),
}));

const doRequestMock = jest.mocked(doRequest);

describe('Apps Plugin - auth', () => {
    let restoreEnv: () => void;

    beforeEach(() => {
        restoreEnv = cleanEnv();
    });

    afterEach(() => {
        restoreEnv();
        jest.clearAllMocks();
    });

    test('Should prefer API-key auth when both keys are set', async () => {
        process.env.DD_API_KEY = 'api-key';
        process.env.DD_APP_KEY = 'app-key';
        process.env.DD_OAUTH_ACCESS_TOKEN = 'oauth-token';
        doRequestMock.mockResolvedValue('ok');

        await expect(
            getAuthenticatedRequest()({ url: 'https://api.datadoghq.com/test' }),
        ).resolves.toBe('ok');
        expect(doRequestMock).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: {
                apiKey: 'api-key',
                appKey: 'app-key',
            },
            fetchImpl: globalThis.fetch,
        });
    });

    test('Should fall back to the OAuth access token when API keys are absent', async () => {
        process.env.DD_OAUTH_ACCESS_TOKEN = 'oauth-token';
        doRequestMock.mockResolvedValue('ok');

        await expect(
            getAuthenticatedRequest()({ url: 'https://api.datadoghq.com/test' }),
        ).resolves.toBe('ok');
        expect(doRequestMock).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: {
                accessToken: 'oauth-token',
            },
            fetchImpl: globalThis.fetch,
        });
    });

    test('Should not use API-key auth when only one key is set', async () => {
        process.env.DD_API_KEY = 'api-key';
        process.env.DD_OAUTH_ACCESS_TOKEN = 'oauth-token';
        doRequestMock.mockResolvedValue('ok');

        await expect(
            getAuthenticatedRequest()({ url: 'https://api.datadoghq.com/test' }),
        ).resolves.toBe('ok');
        expect(doRequestMock).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: {
                accessToken: 'oauth-token',
            },
            fetchImpl: globalThis.fetch,
        });
    });

    test('Should throw when no credentials are configured', () => {
        expect(() => getAuthenticatedRequest()).toThrow(MissingAuthenticationError);
    });

    // A backend function's dependency (MSW, instrumentation) can replace the global after startup.
    test.each([
        { mode: 'API-key', env: { DD_API_KEY: 'api-key', DD_APP_KEY: 'app-key' } },
        { mode: 'OAuth', env: { DD_OAUTH_ACCESS_TOKEN: 'oauth-token' } },
    ])(
        'Should keep using the fetch from when $mode auth was resolved after globalThis.fetch is replaced',
        async ({ env }) => {
            Object.assign(process.env, env);
            doRequestMock.mockResolvedValue('ok');
            const originalFetch = globalThis.fetch;
            const request = getAuthenticatedRequest();
            const replacementFetch = jest.fn();
            Reflect.set(globalThis, 'fetch', replacementFetch);

            try {
                await request({ url: 'https://api.datadoghq.com/test' });
            } finally {
                Reflect.set(globalThis, 'fetch', originalFetch);
            }

            const pinnedFetchRequest = expect.objectContaining({ fetchImpl: originalFetch });

            expect(doRequestMock).toHaveBeenCalledWith(pinnedFetchRequest);
            expect(replacementFetch).not.toHaveBeenCalled();
        },
    );

    // Vite calls configureServer again on a restart, after a dependency may have replaced fetch.
    test('Should keep the fetch from dev server start when auth is resolved again after fetch is replaced', async () => {
        process.env.DD_API_KEY = 'api-key';
        process.env.DD_APP_KEY = 'app-key';
        doRequestMock.mockResolvedValue('ok');
        const originalFetch = globalThis.fetch;
        getAuthenticatedRequest();
        const replacementFetch = jest.fn();
        Reflect.set(globalThis, 'fetch', replacementFetch);

        try {
            const requestAfterRestart = getAuthenticatedRequest();
            await requestAfterRestart({ url: 'https://api.datadoghq.com/test' });
        } finally {
            Reflect.set(globalThis, 'fetch', originalFetch);
        }

        const pinnedFetchRequest = expect.objectContaining({ fetchImpl: originalFetch });

        expect(doRequestMock).toHaveBeenCalledWith(pinnedFetchRequest);
    });

    // Vite bundles a config's non-node_modules imports, so a restart can load a second copy.
    test('Should keep the pinned fetch when a restart loads a separate copy of this module', async () => {
        process.env.DD_API_KEY = 'api-key';
        process.env.DD_APP_KEY = 'app-key';
        doRequestMock.mockResolvedValue('ok');
        const originalFetch = globalThis.fetch;
        getAuthenticatedRequest();
        const replacementFetch = jest.fn();
        Reflect.set(globalThis, 'fetch', replacementFetch);
        let copyDoRequest: jest.MockedFunction<typeof doRequest> | undefined;

        try {
            jest.isolateModules(() => {
                const copy: typeof import('@dd/apps-plugin/auth') = require('@dd/apps-plugin/auth');
                const copyRequestModule: typeof import('@dd/core/helpers/request') = require('@dd/core/helpers/request');
                copyDoRequest = jest.mocked(copyRequestModule.doRequest);
                copy.getAuthenticatedRequest()({ url: 'https://api.datadoghq.com/test' });
            });
        } finally {
            Reflect.set(globalThis, 'fetch', originalFetch);
        }
        const pinnedFetchRequest = expect.objectContaining({ fetchImpl: originalFetch });

        expect(copyDoRequest).toHaveBeenCalledWith(pinnedFetchRequest);
    });
});
