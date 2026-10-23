// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { APP_CSP_DIRECTIVES } from '@dd/apps-plugin/vite/app-csp';

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
