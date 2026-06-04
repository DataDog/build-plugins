// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEFAULT_SITE } from '@dd/core/constants';
import {
    DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE,
    MissingRequestAuthError,
    hasValidAppApiKey,
    withApiAuth,
    withBaseUrl,
} from '@dd/core/helpers/request-auth';
import type { AuthOptionsWithDefaults } from '@dd/core/types';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';

describe('Core - request auth', () => {
    const auth: AuthOptionsWithDefaults = {
        apiKey: 'api-key',
        appKey: 'app-key',
        site: DEFAULT_SITE,
    };
    const log = getMockLogger();

    beforeEach(() => {
        mockLogFn.mockClear();
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
