// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { TrackedFilesMatcher } from '@dd/internal-git-plugin/trackedFilesMatcher';

describe('Git Plugin TrackedFilesMatcher', () => {
    describe('related cases', () => {
        test('related path', () => {
            const sources = ['webpack:///./src/file.ts'];
            const trackedFiles = ['src/file.ts'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toStrictEqual(trackedFiles);
        });
        test('related path in another folder', () => {
            const sources = ['webpack:///./src/file.ts'];
            const trackedFiles = ['path/to/file.ts'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toStrictEqual(trackedFiles);
        });
        test('related path with query parameter', () => {
            const sources = ['file.ts?abc123'];
            const trackedFiles = ['src/file.ts'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toStrictEqual(trackedFiles);
        });
        test('related path with legit question mark', () => {
            const sources = ['file.ts?abc123'];
            const trackedFiles = ['src/file.ts?abc123'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toStrictEqual(trackedFiles);
        });
        test('related hidden file', () => {
            const sources = ['src/.file.ts'];
            const trackedFiles = ['folder/.file.ts'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toStrictEqual(trackedFiles);
        });
    });
    describe('not related cases', () => {
        test('not related', () => {
            const sources = ['folder/other.ts'];
            const trackedFiles = ['src/file.ts'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toHaveLength(0);
        });
    });
    describe('more complex cases', () => {
        test('filename not at the end of tracked file', () => {
            const sources = [
                'webpack:///./.yarn/cache/testfile.js-npm-1.2.3-abc1234567-abc1234567.zip/node_modules/testfile.js/testfile.js',
            ];
            const trackedFiles = ['.yarn/cache/testfile.js-npm-1.1.1-abc1234567-abc1234567.zip'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toHaveLength(0);
        });
        test('multiple related tracked files from one source', () => {
            const sources = ['webpack:///./src/file.ts'];
            const trackedFiles = ['src/file.ts', 'src/commands/sourcemaps/file.ts', 'other'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toStrictEqual([
                'src/file.ts',
                'src/commands/sourcemaps/file.ts',
            ]);
        });
        test('mix of related and not related', () => {
            const sources = ['folder/file.ts', 'folder/other.ts'];
            const trackedFiles = ['src/file.ts', 'file.ts', 'src/other2.ts'];
            const matcher = new TrackedFilesMatcher(trackedFiles);
            expect(matcher.matchSources(sources)).toStrictEqual(['src/file.ts', 'file.ts']);
        });
    });
});
