// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

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
        });
    });

    test('Should throw when no credentials are configured', () => {
        expect(() => getAuthenticatedRequest()).toThrow(MissingAuthenticationError);
    });
});
