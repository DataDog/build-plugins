// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { isInjectionFile } from '@dd/core/helpers/plugins';
import fs from 'fs';
import path from 'path';

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
    let currentDepth = current.split(path.sep).length;
    while (currentDepth > 0) {
        const packagePath = path.resolve(current, `package.json`);
        // Check if package.json exists in the current directory.
        if (fs.existsSync(packagePath)) {
            highestPackage = current;
        }
        // Remove the last part of the path.
        current = current.split(path.sep).slice(0, -1).join(path.sep);
        currentDepth--;
    }
    return highestPackage;
};

// Find the closest package.json from the current directory.
export const getClosestPackageJson = (currentDir: string): string | undefined => {
    let closestPackage;
    let current = getAbsolutePath(process.cwd(), currentDir);
    while (!closestPackage) {
        const packagePath = path.resolve(current, `package.json`);
        // Check if package.json exists in the current directory.
        if (fs.existsSync(packagePath)) {
            closestPackage = packagePath;
        }
        // Remove the last part of the path.
        current = current.split(path.sep).slice(0, -1).join(path.sep);

        // Exit if we reach the root directory.
        if ([path.sep, ''].includes(current)) {
            break;
        }
    }
    return closestPackage;
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
    const minLength = splitPaths.length ? Math.min(...splitPaths.map((parts) => parts.length)) : 0;
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
