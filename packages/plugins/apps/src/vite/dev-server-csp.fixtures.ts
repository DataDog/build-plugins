// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { APP_CSP_DIRECTIVES } from '@dd/apps-plugin/vite/app-csp';
import http from 'http';

export { sha256Source } from '@dd/apps-plugin/vite/dev-server-csp';

// The preamble @vitejs/plugin-react 4.3+ and @vitejs/plugin-react-swc inject.
export const getPreamble = (base: string) =>
    [
        `import { injectIntoGlobalHook } from "${base}@react-refresh";`,
        'injectIntoGlobalHook(window);',
        'window.$RefreshReg$ = () => {};',
        'window.$RefreshSig$ = () => (type) => type;',
    ].join('\n');

// The preamble older @vitejs/plugin-react 4.x injects.
export const LEGACY_PREAMBLE = [
    'import RefreshRuntime from "/@react-refresh"',
    'RefreshRuntime.injectIntoGlobalHook(window)',
    'window.$RefreshReg$ = () => {}',
    'window.$RefreshSig$ = () => (type) => type',
    'window.__vite_plugin_react_preamble_installed__ = true',
].join('\n');

export const getDirective = (policy: string, name: string): string[] => {
    const directive = policy
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        .find(([directiveName]) => directiveName === name);
    return directive ? directive.slice(1) : [];
};

export const getAppCspDirective = (name: string): readonly string[] =>
    APP_CSP_DIRECTIVES.find(([directiveName]) => directiveName === name)?.[1] ?? [];

export type HttpGetResponse = {
    status: number;
    headers: Record<string, string | string[]>;
    body: string;
};

// headersDistinct keeps a repeated header's values apart, so a response's policies can be counted.
export const httpGet = (port: number, urlPath: string, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<HttpGetResponse>((resolve, reject) => {
        const options = { host: '127.0.0.1', port, path: urlPath, headers, agent: false };
        const req = http.get(options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
                const responseHeaders: Record<string, string | string[]> = {};
                for (const [name, values = []] of Object.entries(res.headersDistinct)) {
                    responseHeaders[name] = values.length === 1 ? values[0] : values;
                }
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body });
            });
        });
        req.on('error', reject);
    });
