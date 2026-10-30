// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * The CSP production serves app files with, copied from `getAppCsp` in web-ui's
 * `packages/apps/app-builder/lib/sandbox-shim/csp.ts`, minus `frame-ancestors`, which the dev
 * server has no frame for.
 */
export const APP_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https:', 'blob:']],
    ['style-src', ["'self'", "'unsafe-inline'", 'https:', 'blob:']],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['font-src', ["'self'", 'data:', 'https:']],
    ['media-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['connect-src', ["'self'", 'https:', 'data:', 'blob:']],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'none'"]],
    ['frame-src', ['https:', 'blob:']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ['https:']],
];

export const formatAppCsp = (extraSources: Readonly<Record<string, readonly string[]>>): string =>
    APP_CSP_DIRECTIVES.map(([name, sources]) =>
        [name, ...sources, ...(extraSources[name] ?? [])].join(' '),
    ).join('; ');
