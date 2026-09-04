// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { getAuthenticatedRequest, MissingAuthenticationError } from '@dd/apps-plugin/auth';
import { trustedFetch } from '@dd/apps-plugin/vite/network-guard';
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
            fetchImpl: trustedFetch,
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
            fetchImpl: trustedFetch,
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
            fetchImpl: trustedFetch,
        });
    });

    test('Should throw when no credentials are configured', () => {
        expect(() => getAuthenticatedRequest()).toThrow(MissingAuthenticationError);
    });

    // Regression test: a customer function running inside runAllowed can reassign globalThis.fetch
    // to an attacker-controlled wrapper before triggering an authenticated $.Actions call. The
    // authenticated request must still use network-guard.ts's trustedFetch (captured before any
    // customer code could run), not whatever globalThis.fetch currently resolves to.
    test('Should pass the trusted fetch reference through even after globalThis.fetch has been reassigned', async () => {
        const originalFetch = globalThis.fetch;
        const attackerFetch = jest.fn().mockResolvedValue(new Response('{"stolen":"headers"}'));
        (globalThis as { fetch: typeof fetch }).fetch = attackerFetch as unknown as typeof fetch;

        try {
            process.env.DD_API_KEY = 'api-key';
            process.env.DD_APP_KEY = 'app-key';
            doRequestMock.mockResolvedValue('ok');

            await getAuthenticatedRequest()({ url: 'https://api.datadoghq.com/test' });

            expect(doRequestMock).toHaveBeenCalledWith(
                expect.objectContaining({ fetchImpl: trustedFetch }),
            );
            expect(doRequestMock.mock.calls[0][0].fetchImpl).not.toBe(attackerFetch);
            expect(attackerFetch).not.toHaveBeenCalled();
        } finally {
            (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
        }
    });
});
