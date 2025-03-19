// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { isInjectionFile } from '@dd/core/helpers/plugins';
import type { BundlerFullName, GlobalContext, Logger, ResolvedEntry } from '@dd/core/types';
import type { PluginBuild } from 'esbuild';
import fs from 'fs';
import { glob } from 'glob';
import path from 'path';

// Format a duration 0h 0m 0s 0ms
export const formatDuration = (duration: number) => {
    const days = Math.floor(duration / 1000 / 60 / 60 / 24);
    const usedDuration = duration - days * 24 * 60 * 60 * 1000;
    const d = new Date(usedDuration);
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const milliseconds = d.getUTCMilliseconds();
    const timeString =
        `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${
            seconds ? `${seconds}s` : ''
        }`.trim();
    // Split here so we can show 0ms in case we have a duration of 0.
    return `${timeString}${!timeString || milliseconds ? ` ${milliseconds}ms` : ''}`.trim();
};

// https://esbuild.github.io/api/#glob-style-entry-points
const getAllEntryFiles = (filepath: string): string[] => {
    if (!filepath.includes('*')) {
        return [filepath];
    }

    const files = glob.sync(filepath);
    return files;
};

// Parse, resolve and return all the entries of esbuild.
export const getEsbuildEntries = async (
    build: PluginBuild,
    context: GlobalContext,
    log: Logger,
): Promise<ResolvedEntry[]> => {
    const entries: { name?: string; resolved: string; original: string }[] = [];
    const entryPoints = build.initialOptions.entryPoints;
    const entryPaths: { name?: string; path: string }[] = [];
    const resolutionErrors: string[] = [];

    if (Array.isArray(entryPoints)) {
        for (const entry of entryPoints) {
            const fullPath = entry && typeof entry === 'object' ? entry.in : entry;
            entryPaths.push({ path: fullPath });
        }
    } else if (entryPoints && typeof entryPoints === 'object') {
        entryPaths.push(
            ...Object.entries(entryPoints).map(([name, filepath]) => ({ name, path: filepath })),
        );
    }

    // Resolve all the paths.
    const proms = entryPaths
        .flatMap((entry) =>
            getAllEntryFiles(entry.path).map<[{ name?: string; path: string }, string]>((p) => [
                entry,
                p,
            ]),
        )
        .map(async ([entry, p]) => {
            const result = await build.resolve(p, {
                kind: 'entry-point',
                resolveDir: context.cwd,
            });

            if (result.errors.length) {
                resolutionErrors.push(...result.errors.map((e) => e.text));
            }

            if (result.path) {
                // Store them for later use.
                entries.push({
                    name: entry.name,
                    resolved: result.path,
                    original: entry.path,
                });
            }
        });

    for (const resolutionError of resolutionErrors) {
        log.error(resolutionError);
    }

    await Promise.all(proms);
    return entries;
};

// Truncate a string to a certain length.
// Placing a [...] placeholder in the middle.
// "A way too long sentence could be truncated a bit." => "A way too[...]could be truncated a bit."
export const truncateString = (
    str: string,
    maxLength: number = 60,
    placeholder: string = '[...]',
) => {
    if (str.length <= maxLength) {
        return str;
    }

    // We want to keep at the very least 4 characters.
    const stringLength = Math.max(4, maxLength - placeholder.length);

    // We want to keep most of the end of the string, hence the 10 chars top limit for left.
    const leftStop = Math.min(10, Math.floor(stringLength / 2));
    const rightStop = stringLength - leftStop;

    return `${str.slice(0, leftStop)}${placeholder}${str.slice(-rightStop)}`;
};

// From a bundler's name, is it part of the "xpack" family?
export const isXpack = (bundlerName: BundlerFullName) =>
    ['rspack', 'webpack4', 'webpack5', 'webpack'].includes(bundlerName);

let index = 0;
export const getUniqueId = () => `${Date.now()}.${performance.now()}.${++index}`;

// Will only prepend the cwd if not already there.
export const getAbsolutePath = (cwd: string, filepath: string) => {
    if (isInjectionFile(filepath)) {
        return INJECTED_FILE;
    }

    if (filepath.startsWith(cwd) || path.isAbsolute(filepath)) {
        return filepath;
    }
    return path.resolve(cwd, filepath);
};

// Find the highest package.json from the current directory.
export const getHighestPackageJsonDir = (currentDir: string): string | undefined => {
    let highestPackage;
    let current = getAbsolutePath(process.cwd(), currentDir);
    let currentDepth = current.split('/').length;
    while (currentDepth > 0) {
        const packagePath = path.resolve(current, `package.json`);
        // Check if package.json exists in the current directory.
        if (fs.existsSync(packagePath)) {
            highestPackage = current;
        }
        // Remove the last part of the path.
        current = current.split('/').slice(0, -1).join('/');
        currentDepth--;
    }
    return highestPackage;
};

// From a list of path, return the nearest common directory.
export const getNearestCommonDirectory = (dirs: string[], cwd?: string) => {
    const dirsToCompare = [...dirs];

    // We include the CWD because it's part of the paths we want to compare.
    if (cwd) {
        dirsToCompare.push(cwd);
    }

    const splitPaths = dirsToCompare.map((dir) => {
        const absolutePath = getAbsolutePath(cwd || process.cwd(), dir);
        return absolutePath.split(path.sep);
    });

    // Use the shortest length for faster results.
    const minLength = Math.min(...splitPaths.map((parts) => parts.length));
    const commonParts = [];

    for (let i = 0; i < minLength; i++) {
        // We use the first path as our basis.
        const component = splitPaths[0][i];
        if (splitPaths.every((parts) => parts[i] === component)) {
            commonParts.push(component);
        } else {
            break;
        }
    }

    return commonParts.length > 0
        ? // Use "|| path.sep" to cover for the [''] case.
          commonParts.join(path.sep) || path.sep
        : path.sep;
};
