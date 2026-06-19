// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAuthenticatedRequest, MissingAuthenticationError } from '@dd/apps-plugin/auth';
import { doOAuthRequest } from '@dd/core/helpers/oauth-request';
import { doRequest } from '@dd/core/helpers/request';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';

jest.mock('@dd/core/helpers/oauth-request', () => ({
    doOAuthRequest: jest.fn(),
}));

jest.mock('@dd/core/helpers/request', () => ({
    doRequest: jest.fn(),
}));

const doOAuthRequestMock = jest.mocked(doOAuthRequest);
const doRequestMock = jest.mocked(doRequest);

describe('Apps Plugin - auth', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('Should build an OAuth request function', async () => {
        doOAuthRequestMock.mockResolvedValue('ok');
        const log = getMockLogger();
        const doAuthenticatedRequest = getAuthenticatedRequest(
            'oauth',
            { site: 'datadoghq.com' },
            log,
        );

        await expect(
            doAuthenticatedRequest({ url: 'https://api.datadoghq.com/test' }),
        ).resolves.toBe('ok');
        expect(doOAuthRequestMock).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: { site: 'datadoghq.com' },
            log,
        });
    });

    test('Should build an API-key request function when both keys are available', async () => {
        doRequestMock.mockResolvedValue('ok');
        const log = getMockLogger();
        const doAuthenticatedRequest = getAuthenticatedRequest(
            'apiKey',
            {
                apiKey: 'api-key',
                appKey: 'app-key',
                site: 'datadoghq.com',
            },
            log,
        );

        await expect(
            doAuthenticatedRequest({ url: 'https://api.datadoghq.com/test' }),
        ).resolves.toBe('ok');
        expect(doRequestMock).toHaveBeenCalledWith({
            url: 'https://api.datadoghq.com/test',
            auth: {
                apiKey: 'api-key',
                appKey: 'app-key',
            },
        });
    });

    test('Should throw when API-key credentials are incomplete', () => {
        expect(() =>
            getAuthenticatedRequest(
                'apiKey',
                { apiKey: 'api-key', site: 'datadoghq.com' },
                getMockLogger(),
            ),
        ).toThrow(MissingAuthenticationError);
    });
});
