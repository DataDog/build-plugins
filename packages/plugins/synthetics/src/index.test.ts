// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { runServer } from '@dd/core/helpers/server';
import { API_PREFIX, DEFAULT_PORT } from '@dd/synthetics-plugin/constants';
import { getPlugins } from '@dd/synthetics-plugin';
import { getContextMock } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';

jest.mock('@dd/core/helpers/server', () => {
    const original = jest.requireActual('@dd/core/helpers/server');
    return {
        ...original,
        runServer: jest.fn(original.runServer),
    };
});

const runServerMocked = jest.mocked(runServer);

describe('Synthetics Plugin', () => {
    describe('getPlugins', () => {
        test('Should not initialize the plugin if disabled', async () => {
            expect(getPlugins({ synthetics: { disabled: true } }, getContextMock())).toHaveLength(
                0,
            );
        });

        test('Should initialize the plugin if enabled and not configured', async () => {
            expect(
                getPlugins({ synthetics: { disabled: false } }, getContextMock()).length,
            ).toBeGreaterThan(0);
            expect(getPlugins({}, getContextMock()).length).toBeGreaterThan(0);
        });
    });

    describe('Server', () => {
        beforeAll(() => {
            // Allow local server.
            nock.enableNetConnect('127.0.0.1');
        });

        afterEach(async () => {
            // Kill the server.
            try {
                await fetch(`http://127.0.0.1:${DEFAULT_PORT}/${API_PREFIX}/kill`);
            } catch (e) {
                // Do nothing.
            }
        });

        afterAll(() => {
            nock.cleanAll();
            nock.disableNetConnect();
        });

        describe('to run or not to run', () => {
            afterEach(() => {
                // Remove the variables we've set.
                delete process.env.BUILD_PLUGINS_S8S_LOCAL;
                delete process.env.BUILD_PLUGINS_S8S_PORT;
            });
            const expectations = [
                {
                    description: 'not run with no variables',
                    env: {},
                    shouldRun: false,
                },
                {
                    description: 'not run with missing port',
                    env: {
                        BUILD_PLUGINS_S8S_LOCAL: '1',
                    },
                    shouldRun: false,
                },
                {
                    description: 'not run with missing local',
                    env: {
                        BUILD_PLUGINS_S8S_PORT: JSON.stringify(DEFAULT_PORT),
                    },
                    shouldRun: false,
                },
                {
                    description: 'run with both variables',
                    env: {
                        BUILD_PLUGINS_S8S_PORT: JSON.stringify(DEFAULT_PORT),
                        BUILD_PLUGINS_S8S_LOCAL: '1',
                    },
                    shouldRun: true,
                },
            ];

            test.each(expectations)(
                'Should $description.',
                async ({ description, env, shouldRun }) => {
                    // Set the variables.
                    Object.assign(process.env, env);
                    // Run the plugin.
                    getPlugins({}, getContextMock());
                    // Check the server.
                    if (shouldRun) {
                        expect(runServerMocked).toHaveBeenCalled();
                    } else {
                        expect(runServerMocked).not.toHaveBeenCalled();
                    }
                },
            );
        });
    });
});
