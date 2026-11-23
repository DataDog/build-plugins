// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { HtmlTagDescriptor } from 'vite';

import { formatAppCsp } from './app-csp';

export const CSP_VIOLATION_LOGGER_ID = '__datadog-apps-csp-violations';
export const RESOLVED_CSP_VIOLATION_LOGGER_ID = `\0${CSP_VIOLATION_LOGGER_ID}`;
export const CSP_VIOLATION_LOGGER_ID_RE = new RegExp(`^\0${CSP_VIOLATION_LOGGER_ID}$`);

export const CSP_VIOLATION_MESSAGE =
    '[Datadog Apps] The Datadog Apps Content Security Policy blocked {url} ({directive}).';

// The dev server adds sources only after script-src, so these directives mark the app policy.
export const APP_CSP_PREFIX = formatAppCsp({}).split('; ').slice(0, 2).join('; ');

// Plain script, no module syntax: it loads as a classic script so it listens before the page runs.
export const CSP_VIOLATION_LOGGER_SOURCE = `(() => {
    const message = ${JSON.stringify(CSP_VIOLATION_MESSAGE)};
    const appPolicyPrefix = ${JSON.stringify(APP_CSP_PREFIX)};
    const reported = new Set();
    document.addEventListener('securitypolicyviolation', (event) => {
        // A report-only policy blocked nothing, and another policy on the response isn't the app's.
        const isAppPolicy = String(event.originalPolicy).startsWith(appPolicyPrefix);
        if (event.disposition === 'report' || !isAppPolicy) {
            return;
        }
        const blocked = event.blockedURI || 'inline code';
        const key = event.effectiveDirective + ' ' + blocked;
        if (reported.has(key)) {
            return;
        }
        reported.add(key);
        console.warn(
            message
                .replace('{directive}', () => event.effectiveDirective)
                .replace('{url}', () => blocked),
        );
    });
})();
`;

// Returned from a pre-order transformIndexHtml hook, so Vite adds its base to the src.
export const getCspViolationLoggerTags = (isActive: boolean): HtmlTagDescriptor[] =>
    isActive
        ? [
              {
                  tag: 'script',
                  attrs: { src: `/@id/${CSP_VIOLATION_LOGGER_ID}` },
                  injectTo: 'head-prepend',
              },
          ]
        : [];
