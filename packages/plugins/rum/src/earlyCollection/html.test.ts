// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    EARLY_COLLECTION_TAG,
    getNoHtmlWarning,
    hasEarlyCollectionTag,
    injectEarlyCollectionTag,
    isHtmlFile,
} from '@dd/rum-plugin/earlyCollection/html';

describe('Early collection HTML', () => {
    describe('isHtmlFile', () => {
        test.each([
            ['index.html', true],
            ['nested/page.HTM', true],
            ['main.js', false],
            ['index.html.map', false],
        ])('%s -> %s', (file, expected) => {
            expect(isHtmlFile(file)).toBe(expected);
        });
    });

    describe('injectEarlyCollectionTag', () => {
        test('Should add the tag as the first child of <head>', () => {
            const result = injectEarlyCollectionTag(
                '<!DOCTYPE html><html><head><meta charset="utf-8"><script src="app.js"></script></head><body></body></html>',
            );
            expect(result).toEqual({
                injected: true,
                html: `<!DOCTYPE html><html><head>${EARLY_COLLECTION_TAG}<meta charset="utf-8"><script src="app.js"></script></head><body></body></html>`,
            });
        });

        test('Should handle <head> attributes and case', () => {
            const result = injectEarlyCollectionTag(
                '<HTML><HEAD lang="en"><title>a</title></HEAD>',
            );
            expect(result?.html).toBe(
                `<HTML><HEAD lang="en">${EARLY_COLLECTION_TAG}<title>a</title></HEAD>`,
            );
        });

        test('Should not mistake <header> for <head>', () => {
            const result = injectEarlyCollectionTag('<html><body><header></header></body></html>');
            expect(result?.html).toBe(
                `<html><head>${EARLY_COLLECTION_TAG}</head><body><header></header></body></html>`,
            );
        });

        test('Should be idempotent', () => {
            const first = injectEarlyCollectionTag('<html><head></head></html>');
            const second = injectEarlyCollectionTag(first!.html);
            expect(second).toEqual({ html: first!.html, injected: false });
        });

        test('Should ignore <head> and <html> in comments, scripts and conditional comments', () => {
            const result = injectEarlyCollectionTag(
                '<!--[if IE]><html class="ie"><![endif]--><!-- <head> --><html><head><script>const a = "<head>";</script></head></html>',
            );
            expect(result?.html).toBe(
                `<!--[if IE]><html class="ie"><![endif]--><!-- <head> --><html><head>${EARLY_COLLECTION_TAG}<script>const a = "<head>";</script></head></html>`,
            );
        });

        test('Should handle ">" in quoted <head> attributes', () => {
            const result = injectEarlyCollectionTag('<html><head data-a=">"><title>a</title>');
            expect(result?.html).toBe(
                `<html><head data-a=">">${EARLY_COLLECTION_TAG}<title>a</title>`,
            );
        });

        test('Should not be fooled by a comment mentioning the file', () => {
            const html = '<html><head><!-- datadog-early-collection.js --></head></html>';
            expect(injectEarlyCollectionTag(html)?.injected).toBe(true);
        });

        test('Should not inject when the page already loads the script from elsewhere', () => {
            const html =
                '<html><head><script src="/vendor/datadog-early-collection.js"></script></head>';
            expect(injectEarlyCollectionTag(html)).toEqual({ html, injected: false });
        });

        test('Should skip the documents without <head> nor <html>', () => {
            expect(injectEarlyCollectionTag('<div>partial</div>')).toBeUndefined();
        });
    });

    describe('hasEarlyCollectionTag', () => {
        test.each([
            [EARLY_COLLECTION_TAG, true],
            [
                '<script defer src="https://cdn.example.com/datadog-early-collection.js"></script>',
                true,
            ],
            ["<script src='/datadog-early-collection.js'></script>", true],
            ['<!-- <script src="/datadog-early-collection.js"></script> -->', false],
            ['<link rel="preload" href="/datadog-early-collection.js" as="script">', false],
            ['<script src="/app.js"></script>', false],
        ])('%s -> %s', (html, expected) => {
            expect(hasEarlyCollectionTag(html)).toBe(expected);
        });
    });

    describe('getNoHtmlWarning', () => {
        test('Should only mention the plugin order for esbuild', () => {
            expect(getNoHtmlWarning('reason', 'esbuild')).toContain('after the plugin');
            expect(getNoHtmlWarning('reason', 'webpack')).not.toContain('after the plugin');
            expect(getNoHtmlWarning('reason', 'webpack')).toContain(EARLY_COLLECTION_TAG);
        });
    });
});
