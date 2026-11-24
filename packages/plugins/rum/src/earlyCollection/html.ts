// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const EARLY_COLLECTION_URL =
    'https://www.datadoghq-browser-agent.com/datadog-early-collection.js';
export const EARLY_COLLECTION_FILENAME = 'datadog-early-collection.js';

// A classic, blocking script on purpose: it must run before anything else in the page,
// including the RUM SDK and the application code.
export const EARLY_COLLECTION_TAG = `<script src="${EARLY_COLLECTION_URL}"></script>`;

const HTML_FILE_RX = /\.html?$/i;
// "<head>" or "<head attr>", but not "<header>".
const HEAD_OPEN_RX = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN_RX = /<html(?:\s[^>]*)?>/i;

export const isHtmlFile = (filename: string): boolean => HTML_FILE_RX.test(filename);

export type InjectionResult = {
    html: string;
    // False when the tag was already present.
    injected: boolean;
};

/**
 * Add the early collection script as the first child of <head>.
 * Returns undefined when the document has no <head> nor <html> (partials, templates, ...).
 */
export const injectEarlyCollectionTag = (html: string): InjectionResult | undefined => {
    if (html.includes(EARLY_COLLECTION_FILENAME)) {
        return { html, injected: false };
    }

    const open = HEAD_OPEN_RX.exec(html);
    if (open) {
        const end = open.index + open[0].length;
        return {
            html: `${html.slice(0, end)}${EARLY_COLLECTION_TAG}${html.slice(end)}`,
            injected: true,
        };
    }

    // No <head>: browsers create it implicitly, so a script right after <html> ends up in it.
    const root = HTML_OPEN_RX.exec(html);
    if (root) {
        const end = root.index + root[0].length;
        return {
            html: `${html.slice(0, end)}<head>${EARLY_COLLECTION_TAG}</head>${html.slice(end)}`,
            injected: true,
        };
    }

    return undefined;
};

export const getNoHtmlWarning = (): string =>
    [
        'rum.earlyCollection is enabled but no HTML file was found in the build output (for esbuild, list the Datadog plugin after the plugin writing your HTML), so the early collection script was not injected.',
        'Add this tag as the first <script> of your page <head> instead:',
        `  ${EARLY_COLLECTION_TAG}`,
    ].join('\n');
