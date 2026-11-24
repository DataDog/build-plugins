// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    EARLY_COLLECTION_TAG,
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

        test('Should skip the documents without <head> nor <html>', () => {
            expect(injectEarlyCollectionTag('<div>partial</div>')).toBeUndefined();
        });
    });
});
