// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { runServer } from '@dd/core/helpers/server';
import { getContext } from '@dd/factory/helpers';
import { API_PREFIX } from '@dd/synthetics-plugin/constants';
import type { ServerResponse } from '@dd/synthetics-plugin/types';
import { getPlugins } from '@dd/synthetics-plugin';
import { getContextMock, mockLogFn, mockLogger } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import fs from 'fs';
import nock from 'nock';
import path from 'path';

jest.mock('@dd/core/helpers/server', () => {
    const original = jest.requireActual('@dd/core/helpers/server');
    return {
        ...original,
        runServer: jest.fn(original.runServer),
    };
});

jest.mock('@dd/factory/helpers', () => {
    const original = jest.requireActual('@dd/factory/helpers');
    return {
        ...original,
        getContext: jest.fn(original.getContext),
    };
});

const runServerMocked = jest.mocked(runServer);
const getContextMocked = jest.mocked(getContext);

// Get an incremental port to prevent conflicts.
let PORT = 1234;
const getPort = () => PORT++;
const getApiUrl = (port: number = getPort()) => `http://127.0.0.1:${port}`;
const getInternalApiUrl = (port: number = getPort()) => `${getApiUrl(port)}/${API_PREFIX}`;
const safeFetch = async (route: string, port: number) => {
    try {
        return await fetch(`${getInternalApiUrl(port)}${route}`);
    } catch (e) {
        // Do nothing.
    }
};

// Wait for the local server to tell us that the build is complete.
const waitingForBuild = (port: number, cb: (resp: ServerResponse) => void) => {
    return new Promise<void>((resolve, reject) => {
        // Stop the polling after 10 seconds.
        const timeout = setTimeout(() => {
            clearInterval(interval);
            reject(new Error('Timeout.'));
        }, 10000);

        // Poll all the local servers until we get the build status.
        const interval = setInterval(async () => {
            const res = await safeFetch('/build-status', port);
            if (res?.ok) {
                const data = (await res.json()) as ServerResponse;
                cb(data);

                if (['success', 'fail'].includes(data.status)) {
                    clearInterval(interval);
                    clearTimeout(timeout);

                    if (data.status === 'success') {
                        resolve();
                    }
                    if (data.status === 'fail') {
                        reject(new Error('Build failed.'));
                    }
                }
            }
        }, 100);
    });
};

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

        afterAll(() => {
            nock.cleanAll();
            nock.disableNetConnect();
        });

        describe('to run or not to run', () => {
            afterEach(async () => {
                // Remove the variable we may have set.
                delete process.env.BUILD_PLUGINS_S8S_PORT;
            });

            const expectations = [
                {
                    description: 'not run with no env',
                    env: {},
                    config: {},
                    triggers: 1,
                    expectedNumberOfCalls: 0,
                },
                {
                    description: 'run with port in env',
                    env: {
                        BUILD_PLUGINS_S8S_PORT: JSON.stringify(getPort()),
                    },
                    config: {},
                    triggers: 1,
                    expectedNumberOfCalls: 1,
                },
                {
                    description: 'not run with disabled and port in env',
                    env: {
                        BUILD_PLUGINS_S8S_PORT: JSON.stringify(getPort()),
                    },
                    config: {
                        synthetics: {
                            disabled: true,
                        },
                    },
                    triggers: 1,
                    expectedNumberOfCalls: 0,
                },
                {
                    description: 'not run more than once',
                    env: {
                        BUILD_PLUGINS_S8S_PORT: JSON.stringify(getPort()),
                    },
                    config: {},
                    triggers: 3,
                    expectedNumberOfCalls: 1,
                },
            ];

            test.each(expectations)(
                'Should $description.',
                async ({ config, env, expectedNumberOfCalls, triggers }) => {
                    // Set the variables.
                    Object.assign(process.env, env);

                    // Run the plugin.
                    const [plugin] = getPlugins(config, getContextMock());
                    if (plugin?.bundlerReport) {
                        // Trigger the bundlerReport hook where the server starts.
                        for (let i = 0; i < triggers; i++) {
                            plugin.bundlerReport(getContextMock().bundler);
                        }
                    }

                    // Check the server.
                    expect(runServerMocked).toHaveBeenCalledTimes(expectedNumberOfCalls);

                    // No error should have been logged.
                    expect(mockLogFn).not.toHaveBeenCalledWith(
                        expect.stringContaining('Error starting Synthetics local server'),
                        'error',
                    );

                    if (env.BUILD_PLUGINS_S8S_PORT) {
                        // Kill the server.
                        await safeFetch('/kill', Number(env.BUILD_PLUGINS_S8S_PORT));
                    }
                },
            );

            test('Should not throw if the server fails to start.', async () => {
                // Set the variables.
                Object.assign(process.env, {
                    BUILD_PLUGINS_S8S_PORT: JSON.stringify(getPort()),
                });

                // Make `runServer` throw an error.
                runServerMocked.mockImplementationOnce(() => {
                    throw new Error('Not available.');
                });

                // Run the plugin.
                const [plugin] = getPlugins({ synthetics: { disabled: false } }, getContextMock());
                if (plugin?.bundlerReport) {
                    plugin.bundlerReport(getContextMock().bundler);
                }

                expect(runServerMocked).toHaveBeenCalledTimes(1);
                expect(mockLogFn).toHaveBeenCalledWith(
                    expect.stringContaining('Not available'),
                    'error',
                );
            });
        });

        // We need to loop over bundlers because we'll use a different port for each one of them
        // to avoid port conflicts.
        describe.each(BUNDLERS)('$name', (bundler) => {
            const port = getPort();

            let buildProm: Promise<any>;
            let outDir: string;
            const serverResponses: Set<ServerResponse> = new Set();

            beforeEach(async () => {
                // Set the variables.
                Object.assign(process.env, {
                    BUILD_PLUGINS_S8S_PORT: JSON.stringify(port),
                });

                // Mock the getPlugins function to mock the context.
                getContextMocked.mockImplementation((opts) => {
                    const original = jest.requireActual('@dd/factory/helpers');
                    const mockContext = original.getContext(opts);
                    mockContext.getLogger = jest.fn(() => mockLogger);
                    return mockContext;
                });

                // Run the builds.
                // Do not await the promise as the server will be running.
                buildProm = runBundlers(
                    {
                        // Use a custom plugin to get the cwd and outdir of the build.
                        customPlugins: () => [
                            {
                                name: 'get-outdirs',
                                bundlerReport: (report) => {
                                    outDir = report.outDir;
                                },
                            },
                        ],
                    },
                    undefined,
                    [bundler.name],
                );

                // Instead, wait for the server to tell us that the build is complete.
                await waitingForBuild(port, (resp) => {
                    serverResponses.add(resp);
                });
            });

            afterEach(async () => {
                // Remove the variable we may have set.
                delete process.env.BUILD_PLUGINS_S8S_PORT;
                // Kill the server.
                await safeFetch('/kill', port);
                // Wait for the build to finish now that the server is killed.
                if (buildProm) {
                    await buildProm;
                }
            });

            // NOTE: Due to how mocks reset and the beforeEach/afterEach, we need to have only one test.
            test('Should respond as expected.', async () => {
                // Build status.
                // Verify that we have the running and success statuses.
                const reportedStatus = Array.from(serverResponses).filter((resp) =>
                    ['fail', 'success', 'running'].includes(resp.status),
                );
                expect(reportedStatus.length).toBeGreaterThan(0);

                // Outdir.
                // Verify that we have the running and success statuses.
                const reportedOutDirs = new Set(
                    Array.from(serverResponses).map((resp) => resp.outDir),
                );
                // We should have only one outDir.
                expect(reportedOutDirs.size).toBe(1);
                // It should be the same as the one we reported from the build.
                expect(reportedOutDirs.values().next().value).toEqual(outDir);

                // Built files.
                // Query a file from the server.
                const res = await fetch(`${getApiUrl(port)}/main.js`);
                expect(res.ok).toBe(true);
                const text = await res.text();
                // Confirm that the file served by the server is the same as the one on disk.
                expect(text).toEqual(fs.readFileSync(path.join(outDir, 'main.js'), 'utf-8'));

                // Only one log should have been called.
                expect(mockLogFn).toHaveBeenCalledWith(
                    expect.stringContaining('Starting Synthetics local server'),
                    'debug',
                );
                const nbCalls = mockLogFn.mock.calls.filter(
                    ([message, level]) =>
                        message.includes('Starting Synthetics local server') && level === 'debug',
                ).length;
                expect(nbCalls).toBe(1);

                // No error should have been logged.
                expect(mockLogFn).not.toHaveBeenCalledWith(
                    expect.stringContaining('Error starting Synthetics local server'),
                    'error',
                );
            });
        });
    });
});
