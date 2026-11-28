// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// Hashed assets, like a CDN serves them.
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// HTML and unhashed files: cached, but revalidated on every load.
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

const CONTENT_TYPES: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.webmanifest': 'application/manifest+json',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml; charset=utf-8',
};
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const COMPRESSIBLE_CONTENT_TYPE =
    /^(text\/|application\/(json|manifest\+json|wasm|xml)|image\/svg)/;

type ServedFile = {
    body: Buffer;
    contentType: string;
    etag: string;
    // Null when the file isn't worth compressing.
    gzipBody: Buffer | null;
};

export type StaticServer = {
    origin: string;
    close: () => Promise<void>;
};

export const getCacheControl = (urlPath: string, immutablePaths: RegExp): string => {
    return immutablePaths.test(urlPath) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
};

export const getContentType = (filePath: string): string => {
    const extension = path.extname(filePath).toLowerCase();
    return CONTENT_TYPES[extension] ?? DEFAULT_CONTENT_TYPE;
};

export const acceptsGzip = (acceptEncoding: string | undefined): boolean => {
    return /\bgzip\b/.test(acceptEncoding ?? '');
};

// Maps a request path to a file inside root, or undefined when it points outside.
export const resolveRequestPath = (root: string, urlPath: string): string | undefined => {
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(urlPath);
    } catch {
        return undefined;
    }
    const relativePath = decodedPath.endsWith('/') ? `${decodedPath}index.html` : decodedPath;
    const filePath = path.resolve(root, `.${relativePath}`);
    const isInsideRoot = filePath.startsWith(`${root}${path.sep}`);
    return isInsideRoot ? filePath : undefined;
};

const loadFile = async (filePath: string): Promise<ServedFile | undefined> => {
    try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            return undefined;
        }
        const body = await readFile(filePath);
        const contentType = getContentType(filePath);
        const compressible = COMPRESSIBLE_CONTENT_TYPE.test(contentType);
        return {
            body,
            contentType,
            etag: `"${fileStat.size.toString(16)}-${Math.round(fileStat.mtimeMs).toString(16)}"`,
            gzipBody: compressible ? gzipSync(body) : null,
        };
    } catch {
        return undefined;
    }
};

// Serves a build like production does: hashed assets cached for a year, everything
// else revalidated with ETags, and text compressed with gzip. Files are read once and
// kept in memory, so disk reads don't add noise to the measured loads.
export const startStaticServer = async ({
    immutablePaths,
    root,
}: {
    immutablePaths: RegExp;
    root: string;
}): Promise<StaticServer> => {
    const resolvedRoot = path.resolve(root);
    const files = new Map<string, Promise<ServedFile | undefined>>();
    const getFile = (filePath: string): Promise<ServedFile | undefined> => {
        let file = files.get(filePath);
        if (!file) {
            file = loadFile(filePath);
            files.set(filePath, file);
        }
        return file;
    };

    const server = http.createServer(async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end();
            return;
        }

        const url = new URL(request.url ?? '/', 'http://localhost');
        const filePath = resolveRequestPath(resolvedRoot, url.pathname);
        const file = filePath ? await getFile(filePath) : undefined;
        if (!file) {
            response.writeHead(404, { 'Cache-Control': 'no-store' });
            response.end();
            return;
        }

        const headers: Record<string, string> = {
            'Cache-Control': getCacheControl(url.pathname, immutablePaths),
            'Content-Type': file.contentType,
            ETag: file.etag,
        };
        if (file.gzipBody) {
            headers.Vary = 'Accept-Encoding';
        }
        if (request.headers['if-none-match'] === file.etag) {
            response.writeHead(304, headers);
            response.end();
            return;
        }

        const useGzip = file.gzipBody !== null && acceptsGzip(request.headers['accept-encoding']);
        const body = useGzip && file.gzipBody ? file.gzipBody : file.body;
        if (useGzip) {
            headers['Content-Encoding'] = 'gzip';
        }
        headers['Content-Length'] = String(body.length);
        response.writeHead(200, headers);
        response.end(request.method === 'HEAD' ? undefined : body);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('The runtime server has no TCP address.');
    }

    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
};
