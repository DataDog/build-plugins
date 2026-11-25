// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const EARLY_COLLECTION_URL =
    'https://www.datadoghq-browser-agent.com/datadog-early-collection.js';

// A classic, blocking script on purpose: it must run before anything else in the page,
// including the RUM SDK and the application code.
export const EARLY_COLLECTION_TAG = `<script src="${EARLY_COLLECTION_URL}"></script>`;

const HTML_FILE_RX = /\.html?$/i;
// Attribute values can contain ">" when quoted.
const ATTRIBUTES = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
// "<head>" or "<head attr>", but not "<header>".
const HEAD_OPEN_RX = new RegExp(`<head(?:\\s${ATTRIBUTES})?>`, 'i');
const HTML_OPEN_RX = new RegExp(`<html(?:\\s${ATTRIBUTES})?>`, 'i');
// A script tag loading the early collection file, wherever it is hosted.
const EARLY_COLLECTION_SCRIPT_RX = new RegExp(
    `<script\\b${ATTRIBUTES}\\bsrc\\s*=\\s*["']?[^"'\\s>]*datadog-early-collection\\.js`,
    'i',
);
const COMMENT_RX = /<!--[\s\S]*?-->/g;
// Elements whose content is not markup.
const RAW_TEXT_RX = /<(script|style|textarea|title)\b[\s\S]*?<\/\1\s*>/gi;

const blank = (match: string) => ' '.repeat(match.length);

export const isHtmlFile = (filename: string): boolean => HTML_FILE_RX.test(filename);

/**
 * Whether the page already loads the early collection script (in markup, not in a comment).
 */
export const hasEarlyCollectionTag = (html: string): boolean =>
    EARLY_COLLECTION_SCRIPT_RX.test(html.replace(COMMENT_RX, blank));

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
    if (hasEarlyCollectionTag(html)) {
        return { html, injected: false };
    }

    // Look for the tags outside of comments and raw text elements. Blanking keeps the
    // length unchanged, so the indexes also apply to the original document.
    const markup = html.replace(COMMENT_RX, blank).replace(RAW_TEXT_RX, blank);

    const open = HEAD_OPEN_RX.exec(markup);
    if (open) {
        const end = open.index + open[0].length;
        return {
            html: `${html.slice(0, end)}${EARLY_COLLECTION_TAG}${html.slice(end)}`,
            injected: true,
        };
    }

    // No <head>: browsers create it implicitly, so a script right after <html> ends up in it.
    const root = HTML_OPEN_RX.exec(markup);
    if (root) {
        const end = root.index + root[0].length;
        return {
            html: `${html.slice(0, end)}<head>${EARLY_COLLECTION_TAG}</head>${html.slice(end)}`,
            injected: true,
        };
    }

    return undefined;
};

export const getNoHtmlWarning = (reason: string, bundlerName?: string): string =>
    [
        `rum.earlyCollection is enabled but ${reason}, so the early collection script was not injected.`,
        ...(bundlerName === 'esbuild'
            ? ['With esbuild, list the Datadog plugin after the plugin writing your HTML.']
            : []),
        'Add this tag as the first <script> of your page <head> instead:',
        `  ${EARLY_COLLECTION_TAG}`,
    ].join('\n');
