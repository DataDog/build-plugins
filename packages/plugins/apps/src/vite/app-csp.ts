// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Keep this file free of imports: scripts/check-app-csp-drift.js evaluates it on its own.

/** Where in web-ui the copy below comes from. */
export const APP_CSP_SOURCE = {
    file: 'packages/apps/app-builder/lib/sandbox-shim/csp.ts',
    commit: '228286c7c3d8dd295ea8936190fc6a54308fde25',
};

/** The CSP production serves app files with, minus `frame-ancestors`, which the dev server has no frame for. */
export const APP_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    ['media-src', ["'self'", 'blob:']],
    ['connect-src', ["'self'", 'https:']],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
];

export const formatAppCsp = (extraSources: Readonly<Record<string, readonly string[]>>): string =>
    APP_CSP_DIRECTIVES.map(([name, sources]) =>
        [name, ...sources, ...(extraSources[name] ?? [])].join(' '),
    ).join('; ');
