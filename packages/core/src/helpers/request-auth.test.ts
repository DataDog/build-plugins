// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEFAULT_SITE } from '@dd/core/constants';
import { getOAuthToken } from '@dd/core/helpers/oauth';
import {
    DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE,
    DEFAULT_OAUTH_AND_API_AUTH_MISSING_AUTH_MESSAGE,
    DEFAULT_OAUTH_AUTH_MISSING_AUTH_MESSAGE,
    MissingRequestAuthError,
    authMethodIsOauth,
    hasValidAppApiKey,
    withApiAuth,
    withBaseUrl,
    withOAuthAndApiAuth,
    withOAuthAuth,
} from '@dd/core/helpers/request-auth';
import type { AuthOptionsWithDefaults } from '@dd/core/types';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';

jest.mock('@dd/core/helpers/oauth', () => {
    const actual = jest.requireActual('@dd/core/helpers/oauth');
    return {
        ...actual,
        getOAuthToken: jest.fn(),
    };
});

const getOAuthTokenMock = jest.mocked(getOAuthToken);

describe('Core - request auth', () => {
    const auth: AuthOptionsWithDefaults = {
        apiKey: 'api-key',
        appKey: 'app-key',
        site: DEFAULT_SITE,
    };
    const log = getMockLogger();

    beforeEach(() => {
        getOAuthTokenMock.mockReset();
        mockLogFn.mockClear();
    });

    test('Should identify OAuth auth methods', () => {
        expect(authMethodIsOauth('oauth')).toBe(true);
        expect(authMethodIsOauth('apiKey')).toBe(false);
        expect(authMethodIsOauth()).toBe(false);
    });

    test('Should identify valid APP/API key auth', () => {
        expect(hasValidAppApiKey(auth)).toBe(true);
        expect(hasValidAppApiKey({ apiKey: 'api-key' })).toBe(false);
    });

    test('Should inject API and APP key auth before calling request', async () => {
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithAuth = withApiAuth({ auth, log })(request);
        expect(() => requestWithAuth.assertAuthConfigured()).not.toThrow();

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).resolves.toBe(
            'ok',
        );

        expect(request).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: { apiKey: 'api-key', appKey: 'app-key' },
        });
    });

    test('Should lazily fetch OAuth token and inject bearer auth before calling request', async () => {
        getOAuthTokenMock.mockResolvedValue({
            accessToken: 'access-token',
            site: DEFAULT_SITE,
        });
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithAuth = withOAuthAuth({ auth, log })(request);

        expect(getOAuthTokenMock).not.toHaveBeenCalled();

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).resolves.toBe(
            'ok',
        );

        expect(getOAuthTokenMock).toHaveBeenCalledTimes(1);
        expect(getOAuthTokenMock).toHaveBeenCalledWith(
            DEFAULT_SITE,
            expect.objectContaining({
                authorizationUrl: `https://api.${DEFAULT_SITE}/oauth2/v1/authorize`,
                tokenUrl: `https://api.${DEFAULT_SITE}/oauth2/v1/token`,
            }),
            log,
        );
        expect(request).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: { type: 'bearer', accessToken: 'access-token' },
        });
    });

    test('Should reuse in-flight OAuth token requests', async () => {
        getOAuthTokenMock.mockResolvedValue({
            accessToken: 'access-token',
            site: DEFAULT_SITE,
        });
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithAuth = withOAuthAuth({ auth, log })(request);

        await Promise.all([
            requestWithAuth({ url: 'https://api.datadoghq.com/one' }),
            requestWithAuth({ url: 'https://api.datadoghq.com/two' }),
        ]);

        expect(getOAuthTokenMock).toHaveBeenCalledTimes(1);
    });

    test('Should resolve OAuth token again for sequential requests', async () => {
        getOAuthTokenMock.mockResolvedValue({
            accessToken: 'access-token',
            site: DEFAULT_SITE,
        });
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithAuth = withOAuthAuth({ auth, log })(request);

        await requestWithAuth({ url: 'https://api.datadoghq.com/one' });
        await requestWithAuth({ url: 'https://api.datadoghq.com/two' });

        expect(getOAuthTokenMock).toHaveBeenCalledTimes(2);
    });

    test('Should reset OAuth token cache after authorization failure', async () => {
        getOAuthTokenMock.mockRejectedValueOnce(new Error('oauth failed')).mockResolvedValueOnce({
            accessToken: 'access-token',
            site: DEFAULT_SITE,
        });
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithAuth = withOAuthAuth({ auth, log })(request);

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).rejects.toThrow(
            'oauth failed',
        );
        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).resolves.toBe(
            'ok',
        );

        expect(getOAuthTokenMock).toHaveBeenCalledTimes(2);
    });

    test('Should select API auth from the combined wrapper', async () => {
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithAuth = withOAuthAndApiAuth({
            auth,
            log,
            method: 'apiKey',
        })(request);

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).resolves.toBe(
            'ok',
        );

        expect(getOAuthTokenMock).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: { apiKey: 'api-key', appKey: 'app-key' },
        });
    });

    test('Should select OAuth auth from the combined wrapper', async () => {
        getOAuthTokenMock.mockResolvedValue({
            accessToken: 'access-token',
            site: DEFAULT_SITE,
        });
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithAuth = withOAuthAndApiAuth({
            auth,
            log,
            method: 'oauth',
        })(request);

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).resolves.toBe(
            'ok',
        );

        expect(getOAuthTokenMock).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: { type: 'bearer', accessToken: 'access-token' },
        });
    });

    test('Should warn and reject when API key auth is selected without required credentials', async () => {
        const request = jest.fn();
        const requestWithAuth = withApiAuth({
            auth: {},
            log,
            missingAuthMessage: 'Missing app/api keys.',
        })(request);

        expect(mockLogFn).not.toHaveBeenCalled();

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).rejects.toThrow(
            MissingRequestAuthError,
        );
        expect(mockLogFn).toHaveBeenCalledWith('Missing app/api keys.', 'warn');
        expect(request).not.toHaveBeenCalled();
    });

    test('Should assert missing API key auth before calling request', () => {
        const request = jest.fn();
        const requestWithAuth = withApiAuth({
            auth: {},
            log,
            missingAuthMessage: 'Missing app/api keys.',
        })(request);

        expect(() => requestWithAuth.assertAuthConfigured()).toThrow(MissingRequestAuthError);
        expect(mockLogFn).toHaveBeenCalledWith('Missing app/api keys.', 'warn');
        expect(request).not.toHaveBeenCalled();
    });

    test('Should use the API auth default missing auth message', async () => {
        const request = jest.fn();
        const requestWithAuth = withApiAuth({
            auth: {},
            log,
        })(request);

        expect(mockLogFn).not.toHaveBeenCalled();

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).rejects.toThrow(
            DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE,
        );
        expect(mockLogFn).toHaveBeenCalledWith(DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE, 'warn');
        expect(request).not.toHaveBeenCalled();
    });

    test('Should use the OAuth auth default missing auth message', async () => {
        const request = jest.fn();
        const requestWithAuth = withOAuthAuth({
            auth: {} as Pick<AuthOptionsWithDefaults, 'site'>,
            log,
        })(request);

        expect(mockLogFn).toHaveBeenCalledWith(DEFAULT_OAUTH_AUTH_MISSING_AUTH_MESSAGE, 'warn');

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).rejects.toThrow(
            DEFAULT_OAUTH_AUTH_MISSING_AUTH_MESSAGE,
        );
        expect(getOAuthTokenMock).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    test('Should use the combined auth default missing auth message', async () => {
        const request = jest.fn();
        const requestWithAuth = withOAuthAndApiAuth({
            auth: { site: DEFAULT_SITE },
            log,
            method: 'apiKey',
        })(request);

        expect(mockLogFn).not.toHaveBeenCalled();

        await expect(requestWithAuth({ url: 'https://api.datadoghq.com/test' })).rejects.toThrow(
            DEFAULT_OAUTH_AND_API_AUTH_MISSING_AUTH_MESSAGE,
        );
        expect(mockLogFn).toHaveBeenCalledWith(
            DEFAULT_OAUTH_AND_API_AUTH_MISSING_AUTH_MESSAGE,
            'warn',
        );
        expect(request).not.toHaveBeenCalled();
    });

    test('Should prefix relative request URLs with a base URL', async () => {
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithBaseUrl = withBaseUrl('https://api.datadoghq.com')(request);

        await expect(requestWithBaseUrl({ url: '/api/v2/test' })).resolves.toBe('ok');

        expect(request).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/api/v2/test',
        });
    });

    test('Should preserve absolute request URLs', async () => {
        const request = jest.fn().mockResolvedValue('ok');
        const requestWithBaseUrl = withBaseUrl('https://api.datadoghq.com')(request);

        await expect(requestWithBaseUrl({ url: 'https://custom.apps/upload' })).resolves.toBe('ok');

        expect(request).toHaveBeenCalledWith({
            url: 'https://custom.apps/upload',
        });
    });
});
