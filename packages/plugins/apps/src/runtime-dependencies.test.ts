// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFileSync, readJsonSync } from '@dd/core/helpers/fs';
import { loadsSpecifierThroughIdentifier } from '@dd/tests/_jest/helpers/runtimeLoads';
import { glob } from 'glob';
import path from 'path';

const packagesRoot = path.resolve(__dirname, '../../..');
const publishedPackagesRoot = path.join(packagesRoot, 'published');

// A static import, re-export, side-effect import, dynamic import, or require of
// rollup, anything but a type (`import type`, `typeof import(...)`, `import(...).Type`).
const ROLLUP_RUNTIME_USE_RES = [
    /^\s*import\s+(?!type\b)[^;]*?from\s+['"`]rollup(?:\/[^'"`]*)?['"`]/m,
    /^\s*export\s+(?!type\b)[^;]*?from\s+['"`]rollup(?:\/[^'"`]*)?['"`]/m,
    /^\s*import\s+['"`]rollup(?:\/[^'"`]*)?['"`]/m,
    /(?<!typeof\s+)\bimport\s*\(\s*['"`]rollup(?:\/[^'"`]*)?['"`]\s*\)(?!\s*\.\s*[A-Z])/,
    /\brequire(?:\.resolve)?\s*\(\s*['"`]rollup(?:\/[^'"`]*)?['"`]\s*\)/,
];

// JSDoc types like `{import('rollup').Plugin}` aren't runtime use.
const stripComments = (source: string): string =>
    source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// The rollup plugin peers rollup, so its own source may use it at runtime.
const peersRollupByPackageDir = new Map<string, boolean>();
const isInPackagePeeringRollup = (file: string): boolean => {
    const relativeToPublished = path.relative(publishedPackagesRoot, file);
    if (relativeToPublished.startsWith('..')) {
        return false;
    }
    const [packageDir] = relativeToPublished.split(path.sep);
    let peersRollup = peersRollupByPackageDir.get(packageDir);
    if (peersRollup === undefined) {
        const packageJsonPath = path.join(publishedPackagesRoot, packageDir, 'package.json');
        const { peerDependencies = {} } = readJsonSync(packageJsonPath);
        peersRollup = 'rollup' in peerDependencies;
        peersRollupByPackageDir.set(packageDir, peersRollup);
    }
    return peersRollup;
};

describe('Apps Plugin - runtime dependencies', () => {
    // Vite 8 projects don't otherwise install rollup at all.
    test('Should not make published packages install rollup', async () => {
        const packageJsonPaths = await glob('*/package.json', {
            cwd: publishedPackagesRoot,
            absolute: true,
        });
        const packagesDependingOnRollup = packageJsonPaths.filter((packageJsonPath) => {
            const { dependencies = {}, optionalDependencies = {} } = readJsonSync(packageJsonPath);
            return 'rollup' in dependencies || 'rollup' in optionalDependencies;
        });
        expect(packageJsonPaths.length).toBeGreaterThan(0);
        expect(packagesDependingOnRollup).toEqual([]);
    });

    // Everything here is bundled into the published packages, which only get rollup as a peer.
    test('Should only use rollup for types in bundled source', async () => {
        const sourceFiles = await glob(
            '{plugins/*,core,factory,published/*}/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
            {
                cwd: packagesRoot,
                ignore: ['**/*.test.*', '**/*.fixture.*', '**/*.fixtures.*'],
                absolute: true,
            },
        );
        expect(sourceFiles.length).toBeGreaterThan(0);
        const filesUsingRollupAtRuntime = sourceFiles.filter((file) => {
            if (isInPackagePeeringRollup(file)) {
                return false;
            }
            const source = readFileSync(file);
            const code = stripComments(source);
            return (
                ROLLUP_RUNTIME_USE_RES.some((re) => re.test(code)) ||
                loadsSpecifierThroughIdentifier(code, 'rollup')
            );
        });
        const relativeFiles = filesUsingRollupAtRuntime.map((file) =>
            path.relative(packagesRoot, file),
        );
        expect(relativeFiles).toEqual([]);
    });
});
