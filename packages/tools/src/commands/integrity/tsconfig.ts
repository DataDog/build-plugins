// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJsonSync, readJsonSync } from '@dd/core/helpers/fs';
import { ROOT } from '@dd/tools/constants';
import { green } from '@dd/tools/helpers';
import type { Workspace } from '@dd/tools/types';
import path from 'path';

type PackageExports = Record<string, string | Record<string, string>>;

const buildExpectedPaths = (workspaces: Workspace[]): Record<string, string[]> => {
    const paths: Record<string, string[]> = {};
    for (const workspace of workspaces) {
        if (!workspace.name.startsWith('@dd/')) {
            continue;
        }
        const pkg = readJsonSync(path.resolve(ROOT, workspace.location, 'package.json'));
        const pkgExports: PackageExports | undefined = pkg.exports;
        if (!pkgExports) {
            continue;
        }
        const location = workspace.location.replace(/\\/g, '/');
        const mainExport = pkgExports['.'];
        if (typeof mainExport === 'string') {
            paths[workspace.name] = [`${location}/${mainExport.replace(/^\.\//, '')}`];
        }
        const wildcardExport = pkgExports['./*'];
        if (typeof wildcardExport === 'string') {
            const target = wildcardExport.replace(/^\.\//, '').replace(/\*\.ts$/, '*');
            paths[`${workspace.name}/*`] = [`${location}/${target}`];
        }
    }
    return paths;
};

const sortObject = <T>(obj: Record<string, T>): Record<string, T> => {
    return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
};

export const updateTsconfigPaths = (workspaces: Workspace[]) => {
    const tsconfigPath = path.resolve(ROOT, 'tsconfig.json');
    const tsconfig = readJsonSync(tsconfigPath);
    const expected = sortObject(buildExpectedPaths(workspaces));
    const current = tsconfig.compilerOptions?.paths ?? {};

    if (JSON.stringify(current) === JSON.stringify(expected)) {
        return;
    }

    console.log(`  Update ${green('@dd/*')} paths in ${green('tsconfig.json')}.`);
    tsconfig.compilerOptions = { ...tsconfig.compilerOptions, paths: expected };
    outputJsonSync(tsconfigPath, tsconfig);
};
