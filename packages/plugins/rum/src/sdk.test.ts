// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import { getInjectionValue } from '@dd/rum-plugin/sdk';
import type { RumOptionsWithSdk } from '@dd/rum-plugin/types';
import { validateOptions } from '@dd/rum-plugin/validate';
import { defaultPluginOptions, getContextMock, mockLogger } from '@dd/tests/_jest/helpers/mocks';

// Mock doRequest to intercept the call and mock the result.
jest.mock('@dd/core/helpers/request', () => ({
    doRequest: jest.fn(),
}));
const doRequestMock = jest.mocked(doRequest);

describe('RUM Plugin - SDK', () => {
    describe('getInjectionValue', () => {
        const options = validateOptions(
            {
                ...defaultPluginOptions,
                rum: { sdk: { applicationId: 'app_id' } },
            },
            mockLogger,
        ) as RumOptionsWithSdk;
        const context = getContextMock();

        test('Should throw if no auth.', () => {
            expect(() => {
                getInjectionValue(options, { ...context, auth: { site: 'datadoghq.com' } });
            }).toThrow(
                'Missing "auth.apiKey" and/or "auth.appKey" to fetch "rum.sdk.clientToken".',
            );
        });

        test('Should return the content right away with a given clientToken.', () => {
            const value = getInjectionValue(
                { ...options, sdk: { ...options.sdk, clientToken: 'client_token' } },
                context,
            );
            expect(value).toEqual(expect.stringContaining('DD_RUM.init({'));
        });

        describe('Fetch the clientToken from the API.', () => {
            let injectedValueFn: () => Promise<string>;
            beforeEach(() => {
                injectedValueFn = getInjectionValue(options, context) as () => Promise<string>;
            });

            test('Should get a function.', async () => {
                // It should be a function.
                expect(injectedValueFn).toEqual(expect.any(Function));
            });

            test('Should return the clientToken and use it in the initialization.', async () => {
                doRequestMock.mockResolvedValue({
                    data: {
                        attributes: {
                            client_token: 'client_token',
                        },
                    },
                });

                const value = await injectedValueFn();
                expect(value).toEqual(expect.stringContaining('"clientToken":"client_token",'));
            });

            test('Should throw in case of a network error.', async () => {
                doRequestMock.mockRejectedValue(new Error('Fake Error'));
                await expect(injectedValueFn).rejects.toThrow('Could not fetch the clientToken');
            });

            test('Should throw in case of a missing clientToken in the response.', async () => {
                doRequestMock.mockResolvedValue({
                    data: {},
                });
                await expect(injectedValueFn).rejects.toThrow(
                    'Missing clientToken in the API response.',
                );
            });
        });
    });
});
