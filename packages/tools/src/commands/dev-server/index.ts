// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { SUPPORTED_BUNDLERS } from '@dd/core/constants';
import { runServer } from '@dd/core/helpers/server';
import { ROOT } from '@dd/tools/constants';
import chalk from 'chalk';
import { Command, Option } from 'clipanion';
import type http from 'http';
import template from 'lodash.template';
import { homedir } from 'os';
import path from 'path';

// Some context to use for templating content with {{something}}.
const CONTEXT: Record<string, readonly string[]> = {
    bundler: SUPPORTED_BUNDLERS,
};

// Templating regex.
const INTERPOLATE_RX = /{{([\s\S]+?)}}/g;

class DevServer extends Command {
    static paths = [['dev-server']];

    static usage = Command.Usage({
        category: `Contribution`,
        description: `Run a basic dev server over a specific directory.`,
        details: `
            This command will change the package.json values of "exports" so they can be used from another project.

            This is necessary to be sure that the outside project loads the built files and not the dev files.
        `,
        examples: [
            [`Prepare for link`, `$0 prepare-link`],
            [`Revert change`, `$0 prepare-link --revert`],
        ],
    });

    port = Option.String('--port', '8000', {
        description: 'On which port will the server run.',
    });

    root = Option.String('--root', ROOT, {
        description: 'The root directory the server will serve.',
    });

    parseCookie(cookieHeader?: string): Record<string, string> {
        if (!cookieHeader) {
            return {};
        }

        const cookieString = cookieHeader
            .split(';')
            .find((c) => c.trim().startsWith('context_cookie='));

        if (!cookieString) {
            return {};
        }

        const [name, ...rest] = cookieString.split('=');
        if (!name || !name.trim()) {
            return {};
        }

        const value = rest.join('=').trim();
        if (!value) {
            return {};
        }

        try {
            return JSON.parse(decodeURIComponent(value));
        } catch (e: any) {
            throw new Error(`Error parsing cookie: ${e.message}`);
        }
    }

    getContext(req: http.IncomingMessage): Record<string, string> {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        // Get the initial context from the cookie.
        const fileContext: Record<string, string> = this.parseCookie(req.headers.cookie);

        // Verify if we have context passed as parameters (?context_bundler=vite).
        for (const [key, value] of url.searchParams) {
            if (key.startsWith('context_')) {
                const contextKey = key.replace(/^context_/, '') as keyof typeof CONTEXT;
                if (Object.keys(CONTEXT).includes(contextKey)) {
                    if (CONTEXT[contextKey].includes(value)) {
                        fileContext[contextKey] = value;
                    }
                }
            }
        }

        return fileContext;
    }

    async execute() {
        const absoluteRoot = path.isAbsolute(this.root) ? this.root : path.resolve(ROOT, this.root);
        runServer({
            port: +this.port,
            root: absoluteRoot,
            middleware: async (resp, req) => {
                const statusCode = resp.statusCode;
                const context = this.getContext(req);
                const content = template(resp.body, {
                    interpolate: INTERPOLATE_RX,
                })(context);
                const headers = {
                    'Set-Cookie': `context_cookie=${encodeURIComponent(JSON.stringify(context))};SameSite=Strict;`,
                };

                const c =
                    {
                        200: chalk.green,
                        404: chalk.yellow.bold,
                        500: chalk.red.bold,
                    }[statusCode] || chalk.white;

                console.log(`  -> [${c(statusCode.toString())}] ${req.method} ${req.url}`);
                if (resp.error) {
                    console.log(resp.error);
                }

                return {
                    statusCode: resp.statusCode,
                    headers,
                    body: content,
                };
            },
        });
        const url = chalk.bold.green(`http://127.0.0.1:${this.port}/`);
        const folder = chalk.bold.green(absoluteRoot.replace(homedir(), '~'));
        console.log(`Serving "${folder}" at ${url}.`);
    }
}

export default [DevServer];
