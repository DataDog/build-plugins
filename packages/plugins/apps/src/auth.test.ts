// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getRequestAuth } from '@dd/apps-plugin/auth';

describe('Apps Plugin - auth', () => {
    test('Should build OAuth request auth from the resolved site', () => {
        expect(getRequestAuth('oauth', { site: 'datadoghq.com' })).toEqual({
            authMethod: 'oauth',
            site: 'datadoghq.com',
        });
    });

    test('Should build API-key request auth when both keys are available', () => {
        expect(
            getRequestAuth('apiKey', {
                apiKey: 'api-key',
                appKey: 'app-key',
                site: 'datadoghq.com',
            }),
        ).toEqual({
            authMethod: 'apiKey',
            apiKey: 'api-key',
            appKey: 'app-key',
            site: 'datadoghq.com',
        });
    });

    test('Should return undefined when API-key credentials are incomplete', () => {
        expect(getRequestAuth('apiKey', { apiKey: 'api-key', site: 'datadoghq.com' })).toBe(
            undefined,
        );
    });
});
