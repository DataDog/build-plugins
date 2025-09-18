// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerName, GlobalContext, Logger, ResolvedEntry } from '@dd/core/types';
import type { PluginBuild } from 'esbuild';
import { glob } from 'glob';

// https://esbuild.github.io/api/#glob-style-entry-points
// Exported only for testing purposes.
export const getAllEntryFiles = (filepath: string): string[] => {
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
                resolveDir: context.buildRoot,
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

// From a bundler's name, is it part of the "xpack" family?
export const isXpack = (bundlerName: BundlerName) => ['rspack', 'webpack'].includes(bundlerName);
