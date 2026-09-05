// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';
import picomatch from 'picomatch';

import type { FileExtensions, LiveDebuggerOptionsWithDefaults } from './types';

type Pattern = string | RegExp;
type Matcher = (id: string) => boolean;

const BACKSLASH_PATTERN = /\\/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Z]:[\\/]|\\\\)/i;
const ID_SUFFIX_PATTERN = /[?#]/;

const normalizePath = (filePath: string): string => filePath.replace(BACKSLASH_PATTERN, '/');

const resolveGlob = (glob: string): string => {
    if (
        glob.startsWith('**') ||
        path.isAbsolute(glob) ||
        WINDOWS_ABSOLUTE_PATH_PATTERN.test(glob)
    ) {
        return normalizePath(glob);
    }

    const absoluteGlob = path.resolve(glob);
    return normalizePath(absoluteGlob);
};

const createPatternMatcher = (pattern: Pattern): Matcher => {
    if (pattern instanceof RegExp) {
        return (id) => {
            const normalizedId = normalizePath(id);
            const matches = pattern.test(normalizedId);
            pattern.lastIndex = 0;
            return matches;
        };
    }

    const glob = resolveGlob(pattern);
    const matchesGlob = picomatch(glob, { dot: true });
    return (id) => {
        const normalizedId = normalizePath(id);
        return matchesGlob(normalizedId);
    };
};

const createPatternFilter = (include: Pattern[], exclude: Pattern[]): Matcher => {
    const includeMatchers = include.map(createPatternMatcher);
    const excludeMatchers = exclude.map(createPatternMatcher);

    return (id) => {
        if (excludeMatchers.some((matches) => matches(id))) {
            return false;
        }

        return includeMatchers.length === 0 || includeMatchers.some((matches) => matches(id));
    };
};

const createFileExtensionFilter = (fileExtensions: FileExtensions): Matcher => {
    if (fileExtensions === 'all') {
        return () => true;
    }

    const normalizedExtensions = fileExtensions.map((extension) => extension.toLowerCase());
    return (id) => {
        const [filePath] = id.split(ID_SUFFIX_PATTERN);
        const normalizedFilePath = filePath.toLowerCase();
        return normalizedExtensions.some((extension) => normalizedFilePath.endsWith(extension));
    };
};

export const createFileFilter = (
    options: Pick<LiveDebuggerOptionsWithDefaults, 'include' | 'exclude' | 'fileExtensions'>,
): Matcher => {
    const matchesPatterns = createPatternFilter(options.include, options.exclude);
    const matchesFileExtension = createFileExtensionFilter(options.fileExtensions);

    return (id) => matchesFileExtension(id) && matchesPatterns(id);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const createFileExtensionPattern = (fileExtensions: FileExtensions): RegExp | undefined => {
    if (fileExtensions === 'all') {
        return undefined;
    }

    const escapedExtensions = fileExtensions.map(escapeRegExp);
    return new RegExp(`(?:${escapedExtensions.join('|')})(?:[?#].*)?$`, 'i');
};
