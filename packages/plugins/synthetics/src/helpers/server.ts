// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import type { Routes } from '@dd/core/helpers/server';
import { getServer } from '@dd/core/helpers/server';
import type { Options, PluginOptions, Logger } from '@dd/core/types';
import { CONFIG_KEY as ERROR_TRACKING } from '@dd/error-tracking-plugin';
import type { Server } from 'http';
import url from 'url';

import { API_PREFIX, PLUGIN_NAME } from '../constants';
import type { ServerResponse, SyntheticsOptionsWithDefaults } from '../types';

const identifier = 'Server Running from the Datadog Synthetics Plugin';
const triedPorts: number[] = [];
export const getPort = (): number => {
    const MIN_PORT = 49152;
    const MAX_PORT = 65535;
    const port = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;
    if (triedPorts.includes(port)) {
        return getPort();
    }
    triedPorts.push(port);
    return port;
};

const killServer = (server?: Server) => {
    if (!server) {
        return;
    }
    server.close();
    server.closeAllConnections();
    server.closeIdleConnections();
};

// Keep it global to avoid creating a new server on each run.
let SERVER: Server | undefined;
const RUNNING_SERVERS: number[] = [];

const verifyServer = async (
    server: Server,
    port: number,
    cb: (portUsed: number) => Promise<void> | void,
): Promise<void> => {
    // Listen for errors.
    const errorListener = async (e: any) => {
        server.removeListener('listening', successListener);
        // If the port is already in use.
        if (e.code === 'EADDRINUSE') {
            // Verify if another instance of the plugin is running on this port.
            const resp = await doRequest<ServerResponse>({
                url: `http://127.0.0.1:${port}/${API_PREFIX}/build-status`,
                retries: 0,
                type: 'json',
            });

            if (resp.identifier === identifier) {
                // Another instance of the plugin is running on this port.
                // Instrument the other server so we can piggyback on it.
                return verifyServer(server, getPort(), cb);
            } else {
                // We have something else running here.
                // Throw an error as the feature can't work.
                throw new Error(`Something else is running on port ${port}.`);
            }
        } else {
            // Something else happened.
            // Forward the error.
            throw e;
        }
    };

    const successListener = async () => {
        // Remove the error listener.
        server.removeListener('error', errorListener);
        // Callback to communicate the port used.
        await cb(port);
    };

    server.once('error', errorListener);
    server.once('listening', successListener);
    server.listen(port);
};

const setupMasterServer = (routes: Routes, log: Logger, runningServers: number[]) => {
    // The master server should forward file request to its sub servers.
    // Could use middleware to do this.
    // It should also have a register route.
    routes[`/${API_PREFIX}/register`] = {
        get: (req, res) => {
            const sendError = (message: string) => {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(message);
            };

            if (!req.url) {
                return sendError('Missing URL.');
            }

            const query = url.parse(req.url, true).query;
            if (!query) {
                return sendError('Missing query.');
            }

            if (!query.port) {
                return sendError('Missing port.');
            }

            log.debug(`Registering port ${query.port} to the master server.`);
            const portsToRegister = Array.isArray(query.port) ? query.port : [query.port];
            runningServers.push(...portsToRegister.map(Number));

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('ok');
        },
    };
};

const setupSubServer = async (masterPort: number, port: number) => {
    // The sub server should register to the master server.
    await doRequest<ServerResponse>({
        url: `http://127.0.0.1:${masterPort}/${API_PREFIX}/register?port=${port}`,
    });
};

export const getServerPlugin = (
    opts: Options,
    options: SyntheticsOptionsWithDefaults,
    log: Logger,
): PluginOptions => {
    // This is the mutable response the server will use to report the build's status.
    const response: ServerResponse = {
        publicPath: opts[ERROR_TRACKING]?.sourcemaps?.minifiedPathPrefix,
        status: 'running',
        identifier,
    };

    const routes: Routes = {
        // TODO: The master server should forward file request to its sub servers.
        // Could use a special __catch_all__, "/*" or "/" route.
        // Route to get the build status.
        [`/${API_PREFIX}/build-status`]: {
            get: (req, res) => {
                // TODO: Status should be based on all the running servers.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            },
        },
        // Route to kill the server.
        [`/${API_PREFIX}/kill`]: {
            get: (req, res) => {
                // TODO: Kill all the sub-servers if we're the master server.
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('ok');
                // kill kill kill.
                killServer(SERVER);
            },
        },
    };

    return {
        name: PLUGIN_NAME,
        // Wait for us to have the bundler report to start the server over the outDir.
        bundlerReport(bundlerReport) {
            response.outDir = bundlerReport.outDir;
            if (options.server?.run && !SERVER) {
                const port = options.server.port;

                // Only create the server first.
                SERVER = getServer({
                    root: response.outDir,
                    routes,
                });

                try {
                    verifyServer(SERVER, port, async (portUsed) => {
                        if (portUsed === port) {
                            log.debug(`Setting up master server on port ${portUsed}.`);
                            setupMasterServer(routes, log, RUNNING_SERVERS);
                        } else {
                            log.debug(`Setting up sub server on port ${portUsed}.`);
                            await setupSubServer(port, portUsed);
                        }
                    });
                } catch (e) {
                    log.error(`Error starting Synthetics local server: ${e}`);
                }
            }
        },
        buildReport(buildReport) {
            if (buildReport.errors.length) {
                response.status = 'fail';
            }
        },
        writeBundle() {
            response.status = 'success';
        },
        esbuild: {
            setup(build) {
                build.onDispose(() => {
                    // We kill the plugin when the build is disposed.
                    killServer(SERVER);
                });
            },
        },
    };
};
