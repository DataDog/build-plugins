// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getHighestPackageJsonDir, getNearestCommonDirectory } from '@dd/core/helpers/paths';
import path from 'path';
import type { InputOptions } from 'rollup';

// Compute the CWD based on a list of directories.
const getCwd = (dirs: Set<string>) => {
    const dirsToUse: Set<string> = new Set(dirs);
    for (const dir of dirs) {
        const highestPackage = getHighestPackageJsonDir(dir);
        if (highestPackage && !dirs.has(highestPackage)) {
            dirsToUse.add(highestPackage);
        }
    }

    // Fall back to the nearest common directory.
    const nearestDir = getNearestCommonDirectory(Array.from(dirsToUse));
    if (nearestDir === path.sep) {
        return undefined;
    }
    return nearestDir;
};

export const getOutDirFromOutputs = (options: InputOptions) => {
    const hasOutput = 'output' in options && options.output;
    if (!hasOutput) {
        return undefined;
    }

    const outputOptions = options.output;
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
            if (typeof input !== 'string') {
                throw new Error('Invalid input type');
            }
            directoriesForCwd.add(path.dirname(input));
        }
    }

    // In case an absolute path has been provided in the output options,
    // we include it in the directories list for CWD computation.
    const outDirFromOutputs = getOutDirFromOutputs(options);
    if (outDirFromOutputs && path.isAbsolute(outDirFromOutputs)) {
        directoriesForCwd.add(outDirFromOutputs);
    }

    const cwd = getCwd(directoriesForCwd);

    if (cwd) {
        return cwd;
    }

    // Fallback to process.cwd() as would Vite and Rollup do in their own process.
    return process.cwd();
};
