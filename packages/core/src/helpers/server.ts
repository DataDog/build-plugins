// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import http from 'http';
import path from 'path';

const MIME_TYPES = {
    default: 'application/octet-stream',
    html: 'text/html; charset=UTF-8',
    js: 'application/javascript',
    css: 'text/css',
    png: 'image/png',
    jpg: 'image/jpg',
    gif: 'image/gif',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
} as const;

type File = {
    found: boolean;
    ext: keyof typeof MIME_TYPES;
    content: string;
};
type RouteVerb = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type Routes = Record<
    string,
    Partial<
        Record<
            RouteVerb,
            (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
        >
    >
>;
export type Response = {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    error?: Error;
};
export type RunServerOptions = {
    port: number;
    root: string;
    routes?: Routes;
    middleware?: (
        resp: Response,
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ) => Partial<Response> | Promise<Partial<Response>>;
};

// Promise to boolean.
const toBool = [() => true, () => false];

export const prepareFile = async (root: string, requestUrl: string): Promise<File> => {
    const staticPath = root
        ? path.isAbsolute(root)
            ? root
            : path.resolve(process.cwd(), root)
        : process.cwd();
    const url = new URL(requestUrl, 'http://127.0.0.1');
    const paths = [staticPath, url.pathname];

    if (url.pathname.endsWith('/')) {
        paths.push('index.html');
    }

    const filePath = path.join(...paths);
    const pathTraversal = !filePath.startsWith(staticPath);
    const exists = await fs.promises.access(filePath).then(...toBool);
    const found = !pathTraversal && exists;
    const ext = path.extname(filePath).substring(1).toLowerCase() as File['ext'];
    const fileContent = found ? await fs.promises.readFile(filePath, { encoding: 'utf-8' }) : '';

    return { found, ext, content: fileContent };
};

export const getServer = ({ root, middleware, routes }: Omit<RunServerOptions, 'port'>) => {
    return http.createServer(async (req, res) => {
        const response: Response = {
            statusCode: 200,
            headers: {},
            body: '',
        };

        try {
            // Handle routes.
            const route = routes?.[req.url || '/'];
            if (route) {
                const verb = req.method?.toLowerCase() as RouteVerb;
                const handler = route[verb];
                if (handler) {
                    // Hands off to the route handler.
                    await handler(req, res);
                    return;
                }
            }

            // Fallback to files.
            const file = await prepareFile(root, req.url || '/');
            const statusCode = file.found ? 200 : 404;
            const mimeType = MIME_TYPES[file.ext] || MIME_TYPES.default;

            response.statusCode = statusCode;
            response.headers['Content-Type'] = mimeType;
            response.body = file.content;
        } catch (e: any) {
            response.statusCode = 500;
            response.headers['Content-Type'] = MIME_TYPES.html;
            response.body = 'Internal Server Error';
            response.error = e;
        }

        if (middleware) {
            const middlewareResponse = await middleware(response, req, res);
            response.statusCode = middlewareResponse.statusCode ?? response.statusCode;
            response.headers = {
                ...response.headers,
                ...(middlewareResponse.headers ?? {}),
            };
            response.body = middlewareResponse.body ?? response.body;
        }

        res.writeHead(response.statusCode, response.headers);
        res.end(response.body);
    });
};

export const runServer = ({ port, root, middleware, routes }: RunServerOptions) => {
    const server = getServer({ root, middleware, routes });
    server.listen(port);
    return server;
};
