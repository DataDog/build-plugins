// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
// The core helpers only write text; the binary case needs raw bytes.
import { symlink, writeFile } from 'fs/promises';
import http from 'http';
import net from 'net';
import nock from 'nock';
import os from 'os';
import path from 'path';
import { gunzipSync } from 'zlib';

import type { StaticServer } from './server';
import {
    getCacheControl,
    IMMUTABLE_CACHE_CONTROL,
    resolveRequestPath,
    REVALIDATE_CACHE_CONTROL,
    startStaticServer,
} from './server';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-server-${process.pid}`);
const IMMUTABLE_PATHS = /^\/assets\/|\.woff2$/;
const HTML = '<!doctype html><script type="module" src="/assets/index-a1B2c3D4.js"></script>';
const SCRIPT = `console.log(${JSON.stringify('x'.repeat(2_000))});`;
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));

type Response = {
    body: Buffer;
    headers: http.IncomingHttpHeaders;
    status: number;
};

const request = (
    server: StaticServer,
    urlPath: string,
    { headers = {}, method = 'GET' }: { headers?: http.OutgoingHttpHeaders; method?: string } = {},
): Promise<Response> => {
    const url = `${server.origin}${urlPath}`;
    return new Promise((resolve, reject) => {
        const outgoing = http.request(url, { headers, method }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({ body, headers: response.headers, status: response.statusCode ?? 0 });
            });
            response.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end();
    });
};

type RawResponse = {
    statusLine: string;
    headers: Record<string, string>;
    body: string;
};

// Sends a request over a plain socket. It sends request targets that
// http.request refuses, and it bypasses the tests' HTTP interceptor, which keeps a
// HEAD request's socket open.
const requestRaw = (
    server: StaticServer,
    target: string,
    method: string = 'GET',
): Promise<RawResponse> => {
    const { hostname, port } = new URL(server.origin);
    return new Promise((resolve, reject) => {
        const socket = net.connect(Number(port), hostname);
        let received = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            received += chunk;
        });
        socket.on('end', () => {
            const [head = '', body = ''] = received.split('\r\n\r\n');
            const [statusLine = '', ...headerLines] = head.split('\r\n');
            const headers: Record<string, string> = {};
            for (const line of headerLines) {
                const separator = line.indexOf(':');
                headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
            }
            resolve({ statusLine, headers, body });
        });
        socket.on('error', reject);
        socket.write(
            `${method} ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`,
        );
    });
};

describe('runtime static server', () => {
    let server: StaticServer;

    beforeAll(async () => {
        nock.enableNetConnect('127.0.0.1');
        await rm(TEST_ROOT);
        const htmlPath = path.resolve(TEST_ROOT, 'build/index.html');
        const scriptPath = path.resolve(TEST_ROOT, 'build/assets/index-a1B2c3D4.js');
        const fontPath = path.resolve(TEST_ROOT, 'build/fonts/Virgil.woff2');
        const outsidePath = path.resolve(TEST_ROOT, 'secret.txt');
        await outputFile(htmlPath, HTML);
        await outputFile(scriptPath, SCRIPT);
        await outputFile(fontPath, '');
        await writeFile(fontPath, BINARY);
        await outputFile(outsidePath, 'secret');
        await symlink(outsidePath, path.resolve(TEST_ROOT, 'build/leak.txt'));
        const root = path.resolve(TEST_ROOT, 'build');
        server = await startStaticServer({ immutablePaths: IMMUTABLE_PATHS, root });
    });

    afterAll(async () => {
        await server.close();
        nock.disableNetConnect();
        await rm(TEST_ROOT);
    });

    const cacheControlCases = [
        {
            description: 'cache hashed assets for a year',
            urlPath: '/assets/index-a1B2c3D4.js',
            expected: IMMUTABLE_CACHE_CONTROL,
        },
        {
            description: 'cache matching fonts for a year',
            urlPath: '/fonts/Virgil.woff2',
            expected: IMMUTABLE_CACHE_CONTROL,
        },
        {
            description: 'revalidate HTML',
            urlPath: '/index.html',
            expected: REVALIDATE_CACHE_CONTROL,
        },
        {
            description: 'revalidate the root page',
            urlPath: '/',
            expected: REVALIDATE_CACHE_CONTROL,
        },
        {
            description: 'revalidate unhashed files',
            urlPath: '/sw.js',
            expected: REVALIDATE_CACHE_CONTROL,
        },
    ];

    test.each(cacheControlCases)('should $description', ({ urlPath, expected }) => {
        expect(getCacheControl(urlPath, IMMUTABLE_PATHS)).toBe(expected);
    });

    const pathCases = [
        {
            description: 'serve index.html for directories',
            urlPath: '/',
            expected: '/root/index.html',
        },
        { description: 'decode request paths', urlPath: '/a%20b.js', expected: '/root/a b.js' },
        {
            description: 'refuse paths outside the root',
            urlPath: '/../secret.txt',
            expected: undefined,
        },
        {
            description: 'refuse encoded traversal',
            urlPath: '/%2e%2e/secret.txt',
            expected: undefined,
        },
        {
            description: 'refuse a sibling with the same prefix',
            urlPath: '/../root2/a.js',
            expected: undefined,
        },
        { description: 'refuse malformed encoding', urlPath: '/%E0%A4%A', expected: undefined },
    ];

    test.each(pathCases)('should $description', ({ urlPath, expected }) => {
        expect(resolveRequestPath('/root', urlPath)).toBe(expected);
    });

    test('should serve HTML for revalidation, with an ETag', async () => {
        const response = await request(server, '/');
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
        expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(response.headers.etag).toEqual(expect.any(String));
        expect(response.body.toString()).toBe(HTML);
    });

    test('should answer a matching revalidation with 304 and no body', async () => {
        const first = await request(server, '/assets/index-a1B2c3D4.js');
        const etag = first.headers.etag ?? '';
        const second = await request(server, '/assets/index-a1B2c3D4.js', {
            headers: { 'If-None-Match': etag },
        });
        expect(second.status).toBe(304);
        expect(second.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
        expect(second.body.length).toBe(0);
    });

    test('should compress text only for clients that accept gzip', async () => {
        const compressed = await request(server, '/assets/index-a1B2c3D4.js', {
            headers: { 'Accept-Encoding': 'gzip, deflate, br' },
        });
        const plain = await request(server, '/assets/index-a1B2c3D4.js');

        expect(compressed.headers['content-encoding']).toBe('gzip');
        expect(compressed.headers.vary).toBe('Accept-Encoding');
        expect(Number(compressed.headers['content-length'])).toBeLessThan(SCRIPT.length);
        const decompressed = gunzipSync(compressed.body);
        expect(decompressed.toString()).toBe(SCRIPT);
        expect(plain.headers['content-encoding']).toBeUndefined();
        expect(plain.body.toString()).toBe(SCRIPT);
    });

    test('should serve binary files byte for byte, uncompressed', async () => {
        const response = await request(server, '/fonts/Virgil.woff2', {
            headers: { 'Accept-Encoding': 'gzip' },
        });
        expect(response.headers['content-type']).toBe('font/woff2');
        expect(response.headers['content-encoding']).toBeUndefined();
        expect(response.body.equals(BINARY)).toBe(true);
    });

    test('should answer HEAD without a body', async () => {
        const response = await requestRaw(server, '/index.html', 'HEAD');
        expect(response.statusLine).toBe('HTTP/1.1 200 OK');
        expect(response.headers['content-length']).toBe(String(HTML.length));
        expect(response.body).toBe('');
    });

    const errorCases = [
        {
            description: 'answer missing files with 404',
            urlPath: '/missing.js',
            method: 'GET',
            expected: 404,
        },
        {
            description: 'not serve files outside the root',
            urlPath: '/%2e%2e/secret.txt',
            method: 'GET',
            expected: 404,
        },
        {
            description: 'not follow a symlink out of the root',
            urlPath: '/leak.txt',
            method: 'GET',
            expected: 404,
        },
        {
            description: 'refuse other methods',
            urlPath: '/index.html',
            method: 'POST',
            expected: 405,
        },
    ];

    test.each(errorCases)('should $description', async ({ urlPath, method, expected }) => {
        const response = await request(server, urlPath, { method });
        expect(response.status).toBe(expected);
    });

    test('should answer a request URL it cannot parse with 400', async () => {
        // Node.js accepts this request target, but it isn't a valid URL.
        const response = await requestRaw(server, '//[');
        expect(response.statusLine).toBe('HTTP/1.1 400 Bad Request');
    });
});
