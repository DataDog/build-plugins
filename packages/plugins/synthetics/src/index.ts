// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { runServer } from '@dd/core/helpers/server';
import type { GlobalContext, GetPlugins, Options } from '@dd/core/types';
import { CONFIG_KEY as ERROR_TRACKING } from '@dd/error-tracking-plugin';
import chalk from 'chalk';
import type { Server } from 'http';

import { API_PREFIX, CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { ServerResponse, SyntheticsOptions } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

export type types = {
    // Add the types you'd like to expose here.
    SyntheticsOptions: SyntheticsOptions;
};

export const getPlugins: GetPlugins = (opts: Options, context: GlobalContext) => {
    const log = context.getLogger(PLUGIN_NAME);
    // Verify configuration.
    const options = validateOptions(opts, log);

    if (options.disabled) {
        return [];
    }

    const response: ServerResponse = {
        publicPath: opts[ERROR_TRACKING]?.sourcemaps?.minifiedPathPrefix,
        status: 'running',
    };

    // Keep it global to avoid creating a new server on each run.
    let server: Server;

    return [
        {
            name: PLUGIN_NAME,
            // Wait for us to have the bundler report to start the server over the outDir.
            bundlerReport(bundlerReport) {
                response.outDir = bundlerReport.outDir;
                if (options.server?.run && !server) {
                    const port = options.server.port;
                    log.debug(
                        `Starting Synthetics local server on ${chalk.bold.cyan(`http://127.0.0.1:${port}`)}.`,
                    );

                    server = runServer({
                        port,
                        root: response.outDir,
                        routes: {
                            [`/${API_PREFIX}/build-status`]: {
                                get: (req, res) => {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify(response));
                                },
                            },
                            [`/${API_PREFIX}/kill`]: {
                                get: (req, res) => {
                                    res.writeHead(200, { 'Content-Type': 'text/html' });
                                    res.end('ok');
                                    // kill kill kill.
                                    server.close();
                                    server.closeAllConnections();
                                    server.closeIdleConnections();
                                },
                            },
                        },
                    });
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
        },
    ];
};
