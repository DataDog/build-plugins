// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INTAKE_HOST, INTAKE_PATH } from '@dd/internal-analytics-plugin/constants';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import nock from 'nock';

describe('Analytics Plugin', () => {
    describe('Without network error.', () => {
        test('Should submit the data.', async () => {
            const replyMock = jest.fn(() => ({}));

            nock(`https://${INTAKE_HOST}`)
                // Intercept logs submissions.
                .post(`/${INTAKE_PATH}`)
                .times(BUNDLERS.length)
                .reply(200, replyMock);

            await runBundlers({
                customPlugins: ({ context }) => {
                    // Change the env so we DO send the logs.
                    context.env = 'production';
                    return [];
                },
            });

            expect(replyMock).toHaveBeenCalledTimes(BUNDLERS.length);

            nock.cleanAll();
        });
    });

    describe('With a network error.', () => {
        beforeAll(async () => {
            nock(`https://${INTAKE_HOST}`)
                // Intercept logs submissions.
                .post(`/${INTAKE_PATH}`)
                // Reply with an error.
                .reply(500, 'Network error.')
                .persist();
        });

        afterAll(async () => {
            nock.cleanAll();
        });

        test('Should not throw.', async () => {
            const { errors } = await runBundlers();
            expect(errors).toHaveLength(0);
        });
    });
});
