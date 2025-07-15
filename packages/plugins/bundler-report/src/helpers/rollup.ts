// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getHighestPackageJsonDir, getNearestCommonDirectory } from '@dd/core/helpers/paths';
import path from 'path';
import type { InputOptions, OutputOptions } from 'rollup';

// Compute the CWD based on a list of directories.
const getCwd = (dirs: Set<string>) => {
    const dirsToUse: Set<string> = new Set();
    for (const dir of dirs) {
        dirsToUse.add(dir);
        const highestPackage = getHighestPackageJsonDir(dir);
        if (highestPackage && !dirs.has(highestPackage)) {
            dirsToUse.add(highestPackage);
        }
    }

    // Fall back to the nearest common directory.
    const nearestDir = getNearestCommonDirectory(Array.from(dirsToUse));
    if (nearestDir !== path.sep) {
        return nearestDir;
    } else {
        return undefined;
    }
};

export const getAbsoluteOutDir = (cwd: string, outDir: string) => {
    if (!outDir) {
        return '';
    }

    return path.isAbsolute(outDir) ? outDir : path.resolve(cwd, outDir);
};

export const getOutDirFromOutputs = (outputOptions: OutputOptions) => {
    const normalizedOutputOptions = Array.isArray(outputOptions) ? outputOptions : [outputOptions];
    // FIXME: This is an oversimplification, we should handle builds with multiple outputs.
    // Ideally, `outDir` should only be computed for the build-report.
    // And build-report should also handle multiple outputs.
    for (const output of normalizedOutputOptions) {
        if (output.dir) {
            return output.dir;
        }
        if (output.file) {
            return path.dirname(output.file);
        }
    }
};

export const computeCwd = (options: InputOptions) => {
    const directoriesForCwd: Set<string> = new Set();

    if (options.input) {
        const normalizedInput = Array.isArray(options.input)
            ? options.input
            : typeof options.input === 'object'
              ? Object.values(options.input)
              : [options.input];

        for (const input of normalizedInput) {
            if (typeof input === 'string') {
                directoriesForCwd.add(path.dirname(input));
            } else {
                throw new Error('Invalid input type');
            }
        }
    }

    // In case an absolute path has been provided in the output options,
    // we include it in the directories list for CWD computation.
    if ('output' in options) {
        const outDirFromOutputs = getOutDirFromOutputs(options.output as OutputOptions);
        if (path.isAbsolute(outDirFromOutputs)) {
            directoriesForCwd.add(getAbsoluteOutDir(process.cwd(), outDirFromOutputs));
        }
    }

    const cwd = getCwd(directoriesForCwd);

    if (cwd) {
        return cwd;
    }

    // Fallback to process.cwd() as would Vite and Rollup do in their own process.
    return process.cwd();
};
