// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { HtmlTagDescriptor } from 'vite';

export const CSP_VIOLATION_LOGGER_ID = '__datadog-apps-csp-violations';
export const RESOLVED_CSP_VIOLATION_LOGGER_ID = `\0${CSP_VIOLATION_LOGGER_ID}`;
export const CSP_VIOLATION_LOGGER_ID_RE = new RegExp(`^\0${CSP_VIOLATION_LOGGER_ID}$`);

export const CSP_VIOLATION_MESSAGE =
    '[Datadog Apps] The app Content Security Policy would block {url} ({directive}). Production applies this policy to uploaded apps under the sandbox shim.';

// Plain script, no module syntax: it loads as a classic script so it listens before the page runs.
export const CSP_VIOLATION_LOGGER_SOURCE = `(() => {
    const message = ${JSON.stringify(CSP_VIOLATION_MESSAGE)};
    const reported = new Set();
    document.addEventListener('securitypolicyviolation', (event) => {
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

// Vite adds its base to the page's URLs before this tag is inserted, so the tag carries it here.
export const getCspViolationLoggerTags = (base: string | undefined): HtmlTagDescriptor[] =>
    base !== undefined
        ? [
              {
                  tag: 'script',
                  attrs: { src: `${base}@id/${CSP_VIOLATION_LOGGER_ID}` },
                  injectTo: 'head-prepend',
              },
          ]
        : [];
