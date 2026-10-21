// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createHash } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';

import { formatAppCsp } from './app-csp';
import { getRequestHost } from './dev-server-request-guard';

export const APP_CSP_HEADER = 'Content-Security-Policy-Report-Only';
export const MIDDLEWARE_MODE_HMR_PORT = 24678;
// A host that serves its own HTML through Vite, such as Storybook, never runs under the sandbox shim.
export const SELF_SERVED_APP_TYPE = 'custom';

interface SocketOptions {
    protocol?: string;
    host?: string;
    port?: number;
    clientPort?: number;
    server?: unknown;
}

export interface CspServerConfig {
    server: {
        hmr?: boolean | SocketOptions;
        // Vite 8 reads its HMR socket options from `server.ws`, and `server.hmr` aliases them.
        ws?: false | SocketOptions;
        middlewareMode?: unknown;
        https?: unknown;
        host?: string | boolean;
        port?: number;
        proxy?: Record<string, unknown>;
    };
}

type HeaderValue = number | string | string[];

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTRIBUTE_RE = /(?:^|\s)src\s*=/i;
const MODULE_TYPE_RE = /(?:^|\s)type\s*=\s*["']?module["']?(?:\s|$)/i;
const PREAMBLE_IMPORT_RE =
    /import\s*(?:\{\s*injectIntoGlobalHook\s*\}|RefreshRuntime)\s*from\s*["'][^"']*\/@react-refresh["'];?/;
const PREAMBLE_INSTALL_RE = /(?:RefreshRuntime\.)?injectIntoGlobalHook\(\s*window\s*\);?/;
const PREAMBLE_STATEMENT_RES = [
    PREAMBLE_IMPORT_RE,
    PREAMBLE_INSTALL_RE,
    /window\.\$RefreshReg\$\s*=\s*\(\)\s*=>\s*\{\s*\};?/,
    /window\.\$RefreshSig\$\s*=\s*\(\)\s*=>\s*\(type\)\s*=>\s*type;?/,
    /window\.__vite_plugin_react_preamble_installed__\s*=\s*true;?/,
];
const HOST_HEADER_RE = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
// A CSP host-source has no IPv6 literal or underscore; 'self' still covers the page's own port.
const CSP_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i;
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '0000:0000:0000:0000:0000:0000:0000:0000']);
const PAGE_DESTINATIONS = new Set(['document', 'iframe', 'frame']);
// Vite 8's bundled dev mode serves this page, which reloads itself from an inline script, while
// it bundles; it's never part of the app.
const VITE_FALLBACK_PAGE_MARKER = 'globalThis.__vite_is_fallback_page__ = true';
// A worker takes its CSP from its own script response, not from the page.
const WORKER_DESTINATIONS = new Set(['worker', 'sharedworker', 'serviceworker']);

export const sha256Source = (content: string) => {
    const digest = createHash('sha256').update(content, 'utf8').digest('base64');
    return `'sha256-${digest}'`;
};

const isReactRefreshPreamble = (attributes: string, content: string): boolean => {
    if (
        SRC_ATTRIBUTE_RE.test(attributes) ||
        !MODULE_TYPE_RE.test(attributes) ||
        !PREAMBLE_IMPORT_RE.test(content) ||
        !PREAMBLE_INSTALL_RE.test(content)
    ) {
        return false;
    }
    const otherCode = PREAMBLE_STATEMENT_RES.reduce(
        (remaining, statement) => remaining.replace(statement, ''),
        content,
    );
    return otherCode.trim() === '';
};

/** The React Refresh preamble is the one inline script dev adds that production doesn't serve. */
export const getReactRefreshPreambleHashes = (html: string): string[] => {
    const hashes: string[] = [];
    for (const [, attributes, content] of html.matchAll(SCRIPT_RE)) {
        if (isReactRefreshPreamble(attributes, content)) {
            // Browsers hash the text after HTML input normalization turns CRLF into LF.
            const parsedContent = content.replace(/\r\n?/g, '\n');
            const hash = sha256Source(parsedContent);
            hashes.push(hash);
        }
    }
    return hashes;
};

const getSocketOptions = ({ server }: CspServerConfig): SocketOptions => {
    if (typeof server.ws === 'object') {
        return server.ws;
    }
    return typeof server.hmr === 'object' ? server.hmr : {};
};

// The Host header lands in the policy, so only a plain host and port is used.
const parsePageHost = (protocol: string, hostHeader: string | undefined): URL | undefined => {
    const pageHost = hostHeader?.trim();
    if (!pageHost || !HOST_HEADER_RE.test(pageHost)) {
        return undefined;
    }
    try {
        return new URL(`${protocol}://${pageHost}`);
    } catch {
        return undefined;
    }
};

/** Mirrors how `@vite/client` picks its HMR WebSocket URL and its direct fallback. */
export const getHmrWebSocketSources = (
    config: CspServerConfig,
    hostHeader: string | undefined,
    isEncrypted: boolean,
): string[] => {
    const { server } = config;
    // The client connects even with HMR off, for reloads and the error overlay.
    if (server.ws === false) {
        return [];
    }
    const socketOptions = getSocketOptions(config);
    const isHttps = isEncrypted || Boolean(server.https);
    const protocol = socketOptions.protocol || (isHttps ? 'wss' : 'ws');
    let clientPort = socketOptions.clientPort || socketOptions.port;
    if (server.middlewareMode && !socketOptions.server) {
        clientPort ||= MIDDLEWARE_MODE_HMR_PORT;
    }

    const sources = new Set<string>();
    const addSource = (hostname: string, port: number | string | undefined) => {
        if (CSP_HOST_RE.test(hostname)) {
            sources.add(`${protocol}://${hostname}${port ? `:${port}` : ''}`);
        }
    };
    const pageUrl = parsePageHost(protocol, hostHeader);
    if (pageUrl) {
        addSource(socketOptions.host || pageUrl.hostname, clientPort || pageUrl.port);
    }
    // Without a client port, the client retries against the server's own address.
    if (!clientPort) {
        const serverHost =
            typeof server.host === 'string' && server.host && !WILDCARD_HOSTS.has(server.host)
                ? server.host
                : 'localhost';
        addSource(socketOptions.host || serverHost, server.port);
    }
    return [...sources];
};

// Proxied responses aren't app files; keys match the way Vite's proxy matches them.
const isProxiedUrl = (proxy: CspServerConfig['server']['proxy'], url: string) =>
    Object.entries(proxy ?? {}).some(
        ([context, options]) =>
            !!options &&
            ((context.startsWith('^') && new RegExp(context).test(url)) || url.startsWith(context)),
    );

const isHtmlContentType = (contentType: unknown): boolean =>
    String(contentType ?? '')
        .trim()
        .toLowerCase()
        .startsWith('text/html');

const isHeaderObject = (headers: unknown): headers is Record<string, HeaderValue> =>
    !!headers && typeof headers === 'object' && !Array.isArray(headers);

const readBody = (chunk: unknown): string | undefined => {
    if (typeof chunk === 'string') {
        return chunk;
    }
    if (chunk instanceof Uint8Array) {
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        return buffer.toString('utf8');
    }
    return undefined;
};

const isTlsSocket = (socket: Socket | undefined): boolean =>
    !!socket && 'encrypted' in socket && socket.encrypted === true;

/**
 * Reports the app CSP on HTML and worker script responses, without enforcing it, so code
 * production would block shows up in dev before upload. A policy already on the response stays.
 */
export const createAppCspMiddleware = (config: CspServerConfig) => {
    return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
        const hasHeaderApi =
            typeof res.getHeader === 'function' && typeof res.setHeader === 'function';
        if (!hasHeaderApi || isProxiedUrl(config.server.proxy, req.url ?? '')) {
            next();
            return;
        }
        const destination = String(req.headers['sec-fetch-dest'] ?? '');
        const isWorkerScript = WORKER_DESTINATIONS.has(destination);
        const isPageRequest =
            PAGE_DESTINATIONS.has(destination) ||
            String(req.headers.accept ?? '').includes('text/html');
        if (isPageRequest || isWorkerScript) {
            // A 304 keeps the policy the browser cached, which may predate this one.
            delete req.headers['if-none-match'];
            delete req.headers['if-modified-since'];
        }

        let isApplied = false;
        const isCovered = () => {
            const contentType = res.getHeader('Content-Type');
            return isWorkerScript || isHtmlContentType(contentType);
        };
        const applyPolicy = (body: string | undefined) => {
            if (isApplied || res.headersSent || !isCovered()) {
                return;
            }
            isApplied = true;
            if (body?.includes(VITE_FALLBACK_PAGE_MARKER)) {
                return;
            }
            const isHashable =
                body !== undefined && !isWorkerScript && !res.getHeader('Content-Encoding');
            const scriptHashes = isHashable ? getReactRefreshPreambleHashes(body) : [];
            const pageHost = getRequestHost(req.headers);
            const isEncrypted = isTlsSocket(req.socket);
            const webSocketSources = getHmrWebSocketSources(config, pageHost, isEncrypted);
            const policy = formatAppCsp({
                'script-src': scriptHashes,
                'connect-src': webSocketSources,
            });
            const existingPolicies = [res.getHeader(APP_CSP_HEADER) ?? []].flat().map(String);
            res.setHeader(APP_CSP_HEADER, [...existingPolicies, policy]);
        };

        const originalWriteHead = res.writeHead;
        const originalWrite = res.write;
        const originalEnd = res.end;
        const originalFlushHeaders = res.flushHeaders;

        // sirv serves public files with writeHead(status, headers); setting those first lets the
        // policy see their Content-Type and sit beside any policy among them.
        Reflect.set(res, 'writeHead', (statusCode: number, ...rest: unknown[]) => {
            const statusMessage = typeof rest[0] === 'string' ? [rest[0]] : [];
            const headers = rest[statusMessage.length];
            const hasHeaderObject = isHeaderObject(headers);
            if (hasHeaderObject) {
                for (const [name, value] of Object.entries(headers)) {
                    res.setHeader(name, value);
                }
            }
            applyPolicy(undefined);
            const args = hasHeaderObject ? [statusCode, ...statusMessage] : [statusCode, ...rest];
            return Reflect.apply(originalWriteHead, res, args);
        });
        Reflect.set(res, 'write', (...args: unknown[]) => {
            applyPolicy(undefined);
            return Reflect.apply(originalWrite, res, args);
        });
        Reflect.set(res, 'end', (...args: unknown[]) => {
            const body = readBody(args[0]);
            applyPolicy(body);
            return Reflect.apply(originalEnd, res, args);
        });
        Reflect.set(res, 'flushHeaders', () => {
            applyPolicy(undefined);
            return Reflect.apply(originalFlushHeaders, res, []);
        });

        next();
    };
};
