// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/ci-visibility-plugin';
import { getContextMock } from '@dd/tests/_jest/helpers/mocks';
import { runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import nock from 'nock';

import { INTAKE_PATH, INTAKE_HOST } from './constants';

describe('Ci Visibility Plugin', () => {
    describe('getPlugins', () => {
        test('Should not initialize the plugin if disabled', async () => {
            expect(
                getPlugins({
                    options: { ciVisibility: { disabled: true } },
                    context: getContextMock(),
                    bundler: {},
                }),
            ).toHaveLength(0);
            expect(
                getPlugins({ options: {}, context: getContextMock(), bundler: {} }),
            ).toHaveLength(0);
        });

        test('Should initialize the plugin if enabled', async () => {
            expect(
                getPlugins({
                    options: { ciVisibility: {} },
                    context: getContextMock(),
                    bundler: {},
                }).length,
            ).toBeGreaterThan(0);
        });
    });

    describe('With a supported CI provider', () => {
        const replyMock = jest.fn(() => ({}));
        beforeAll(async () => {
            nock(`https://${INTAKE_HOST}`)
                // Intercept logs submissions.
                .post(`/${INTAKE_PATH}`)
                .reply(200, replyMock)
                .persist();
        });

        afterAll(async () => {
            nock.cleanAll();
        });

        test('Should send spans to Datadog', async () => {
            // Spoof a github action.
            process.env.GITHUB_ACTIONS = 'true';

            const { errors } = await runBundlers({
                auth: {
                    apiKey: 'test',
                },
                ciVisibility: {},
            });

            expect(errors).toHaveLength(0);
            expect(replyMock).toHaveBeenCalled();

            delete process.env.GITHUB_ACTIONS;
        });
    });
});
