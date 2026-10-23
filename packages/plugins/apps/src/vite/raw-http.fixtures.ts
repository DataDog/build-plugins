// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import net from 'net';

export type RawResponse = {
    status: number;
    headers: Record<string, string | string[]>;
    body: string;
};

const decodeChunked = (body: Buffer): Buffer => {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < body.length) {
        const lineEnd = body.indexOf('\r\n', offset);
        const sizeText = body.subarray(offset, lineEnd).toString('ascii');
        const size = parseInt(sizeText, 16);
        if (!size) {
            break;
        }
        const start = lineEnd + 2;
        const chunk = body.subarray(start, start + size);
        chunks.push(chunk);
        offset = start + size + 2;
    }
    return Buffer.concat(chunks);
};

const parseResponse = (raw: Buffer): RawResponse => {
    const headerEnd = raw.indexOf('\r\n\r\n');
    const head = raw.subarray(0, headerEnd).toString('latin1');
    const [statusLine, ...headerLines] = head.split('\r\n');
    const headers: Record<string, string | string[]> = {};
    for (const line of headerLines) {
        const separator = line.indexOf(':');
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        const existing = headers[name];
        headers[name] = existing === undefined ? value : [existing, value].flat();
    }
    const rawBody = raw.subarray(headerEnd + 4);
    const isChunked = headers['transfer-encoding'] === 'chunked';
    const body = isChunked ? decodeChunked(rawBody) : rawBody;
    const [, status] = statusLine.split(' ');
    return { status: Number(status), headers, body: body.toString('utf8') };
};

// A plain socket rather than the http module, which nock patches: a nock layer that an earlier
// test file leaves on the worker's http module would block these localhost requests.
export const rawGet = (port: number, urlPath: string, headers: Record<string, string> = {}) =>
    new Promise<RawResponse>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        socket.on('error', reject);
        socket.on('end', () => {
            const raw = Buffer.concat(chunks);
            const response = parseResponse(raw);
            resolve(response);
        });
        const requestHeaders = { host: `127.0.0.1:${port}`, ...headers, connection: 'close' };
        const headerLines = Object.entries(requestHeaders).map(
            ([name, value]) => `${name}: ${value}`,
        );
        const request = [`GET ${urlPath} HTTP/1.1`, ...headerLines, '', ''].join('\r\n');
        socket.write(request);
    });
