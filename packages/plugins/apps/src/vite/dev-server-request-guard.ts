// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { IncomingHttpHeaders } from 'http';
import { isIP } from 'net';
import type { ResolvedPreviewOptions, ResolvedServerOptions } from 'vite';

export type HostCheck = (hostHeader: string) => boolean;

export interface HostCheckConfig {
    server: Pick<ResolvedServerOptions, 'allowedHosts' | 'https' | 'host' | 'hmr' | 'origin'>;
    preview: Pick<ResolvedPreviewOptions, 'host'>;
}

export const MISSING_HOST_MESSAGE = 'Blocked request with no Host header.';

export const ALLOWED_HOSTS_HINT =
    'If you trust this host, add it to `server.allowedHosts` in vite.config.js.';

export interface RequestRejection {
    statusCode: 403 | 415;
    message: string;
}

function getConfiguredHosts({ server, preview }: HostCheckConfig): string[] {
    const hosts: string[] = [];
    if (typeof server.host === 'string' && server.host) {
        hosts.push(server.host);
    }
    if (typeof server.hmr === 'object' && server.hmr?.host) {
        hosts.push(server.hmr.host);
    }
    if (typeof preview.host === 'string' && preview.host) {
        hosts.push(preview.host);
    }
    if (server.origin) {
        try {
            const originUrl = new URL(server.origin);
            hosts.push(originUrl.hostname);
        } catch {
            // Vite ignores an unparseable origin too.
        }
    }
    return hosts;
}

function getHostname(hostHeader: string): string {
    const trimmedHost = hostHeader.trim();
    if (trimmedHost.startsWith('[')) {
        const ipv6End = trimmedHost.indexOf(']');
        return ipv6End < 0 ? trimmedHost : trimmedHost.slice(0, ipv6End + 1);
    }
    const colonIndex = trimmedHost.indexOf(':');
    return colonIndex === -1 ? trimmedHost : trimmedHost.slice(0, colonIndex);
}

function matchesAllowedHosts(
    hostHeader: string,
    allowedHosts: readonly unknown[],
    configuredHosts: readonly string[],
): boolean {
    const hostname = getHostname(hostHeader);
    if (hostname.startsWith('[')) {
        const ipv6Address = hostname.slice(1, -1);
        return hostname.endsWith(']') && isIP(ipv6Address) === 6;
    }
    if (isIP(hostname) === 4 || hostname === 'localhost' || hostname.endsWith('.localhost')) {
        return true;
    }
    if (configuredHosts.includes(hostname)) {
        return true;
    }
    return allowedHosts.some(
        (allowedHost) =>
            typeof allowedHost === 'string' &&
            (allowedHost === hostname ||
                (allowedHost.startsWith('.') &&
                    (allowedHost.slice(1) === hostname || hostname.endsWith(allowedHost)))),
    );
}

/**
 * Mirrors Vite's dev-server host check, which Vite doesn't export and Vite 6 runs after plugin
 * middleware. Unlike Vite, it drops the `file:`/`-extension:` allowance.
 */
export function createViteHostCheck(config: HostCheckConfig): HostCheck {
    if (config.server.https) {
        return () => true;
    }
    const configuredHosts = getConfiguredHosts(config);
    return (hostHeader) => {
        // Not an array in an untyped config.
        const { allowedHosts } = config.server;
        if (allowedHosts === true) {
            return true;
        }
        const allowedHostList = Array.isArray(allowedHosts) ? allowedHosts : [];
        return matchesAllowedHosts(hostHeader, allowedHostList, configuredHosts);
    };
}

const NON_AUTHORITY_CHARACTERS_RE = /[@/?#%\\]/;

// The scheme isn't compared: behind a TLS-terminating proxy the Origin is https while the dev server is not.
function isSameOriginAsHost(origin: string, hostHeader: string): boolean {
    if (NON_AUTHORITY_CHARACTERS_RE.test(hostHeader)) {
        return false;
    }
    try {
        const originUrl = new URL(origin);
        return originUrl.host === new URL(`${originUrl.protocol}//${hostHeader}`).host;
    } catch {
        return false;
    }
}

function isJsonContentType(contentType: string | undefined): boolean {
    return contentType?.split(';')[0].trim().toLowerCase() === 'application/json';
}

// HTTP/2 requests carry :authority and no Host.
export function getRequestHost(headers: IncomingHttpHeaders): string | undefined {
    const authority = headers[':authority'];
    return headers.host ?? (typeof authority === 'string' ? authority : undefined);
}

// Node decodes a Host as latin1, and JSON.stringify leaves C1 controls raw for the terminal.
function quoteHostname(hostname: string): string {
    return JSON.stringify(hostname).replace(
        /[^\x20-\x7e]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

export function checkDevServerRequest(
    headers: IncomingHttpHeaders,
    isHostAllowed: HostCheck,
): RequestRejection | undefined {
    const { origin } = headers;
    const host = getRequestHost(headers);
    if (!host) {
        return { statusCode: 403, message: MISSING_HOST_MESSAGE };
    }
    if (!isHostAllowed(host)) {
        const quotedHostname = quoteHostname(getHostname(host));
        return {
            statusCode: 403,
            message: `Blocked request. This host (${quotedHostname}) is not allowed. ${ALLOWED_HOSTS_HINT}`,
        };
    }
    if (origin !== undefined && !isSameOriginAsHost(origin, host)) {
        return {
            statusCode: 403,
            message: "Blocked request. Only the dev server's own origin can call this endpoint.",
        };
    }
    if (!isJsonContentType(headers['content-type'])) {
        return { statusCode: 415, message: 'Requests must use Content-Type: application/json.' };
    }
    return undefined;
}
