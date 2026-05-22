// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// @ts-check

import { generateDtsBundle } from 'dts-bundle-generator';
import fs from 'fs';
import { glob } from 'glob';
import path from 'path';
import ts from 'typescript';

const CWD = process.env.PROJECT_CWD || process.cwd();

/**
 * @typedef {{
 *      main: string;
 *      name: string;
 *      peerDependencies: Record<string,string>;
 *      dependencies: Record<string,string>
 * }} PackageJson
 * @typedef {import('rollup').Plugin} Plugin
 */

/**
 * Walks every plugin's package.json and returns the union of declared
 * `buildPlugin.inlinedLibraries` — packages whose types should be inlined into
 * the bundled .d.ts rather than left as imports (e.g. browser-SDK types that
 * aren't real runtime deps of the published packages).
 * @returns {string[]}
 */
const collectInlinedLibraries = () => {
    const libs = new Set();
    for (const pkg of glob.sync('packages/plugins/*/package.json', { cwd: CWD })) {
        const content = JSON.parse(fs.readFileSync(path.resolve(CWD, pkg), 'utf-8'));
        for (const name of content.buildPlugin?.inlinedLibraries ?? []) {
            libs.add(name);
        }
    }
    return [...libs];
};

/**
 * Converts the root tsconfig's @dd/* `paths` (pointing at .ts sources) to the
 * equivalent .d.ts paths rooted in outDir. Used to redirect dts-bundle-generator
 * to the declarations pre-emitted by pass 1.
 * @param {string} outDir
 * @param {Record<string, string[]>} srcPaths
 * @returns {Record<string, string[]>}
 */
const buildDtsPaths = (outDir, srcPaths) => {
    /** @type {Record<string, string[]>} */
    const result = {};
    const rel = path.relative(CWD, outDir).replace(/\\/g, '/');
    for (const [key, values] of Object.entries(srcPaths)) {
        result[key] = values.map((v) => {
            const dtsV = v.endsWith('.ts') ? v.replace(/\.ts$/, '.d.ts') : v;
            return `${rel}/${dtsV}`;
        });
    }
    return result;
};

/**
 * Returns a rollup plugin that generates a bundled .d.ts using dts-bundle-generator.
 *
 * Two-pass approach to avoid DOM lib vs @types/node conflicts:
 *   Pass 1 — TypeScript emits .d.ts for workspace files without DOM lib (no conflicts
 *            because workspace code is Node.js-only).
 *   Pass 2 — dts-bundle-generator runs against the emitted .d.ts with DOM lib enabled.
 *            Because every reachable file is a .d.ts (entry + @dd/* redirected via
 *            `paths`), it hits the `allFilesAreDeclarations` shortcut in
 *            compile-dts.js and skips its own compilation — so DOM vs Node.js type
 *            conflicts never arise. DOM lib is still needed at this stage so the
 *            TypesUsageEvaluator can resolve Window / EventTarget / XMLHttpRequest
 *            etc. referenced in @datadog/browser-* declarations.
 *
 * @param {PackageJson} packageJson
 * @returns {Plugin}
 */
export const getDtsBundlePlugin = (packageJson) => ({
    name: 'dts-bundle-generator',
    async closeBundle() {
        const safeName = packageJson.name.replace(/[^a-zA-Z0-9]/g, '-');
        const tempDtsDir = path.join(CWD, `.dts-tmp-${safeName}`);
        const tempBundleConfigPath = path.join(tempDtsDir, 'tsconfig.bundle.json');
        const entrySrcPath = path.resolve('src/index.ts');
        const entryDtsPath = path.join(
            tempDtsDir,
            path.relative(CWD, entrySrcPath).replace(/\.ts$/, '.d.ts'),
        );

        fs.mkdirSync(tempDtsDir, { recursive: true });
        try {
            // Workspace @dd/* paths live in the root tsconfig — both passes
            // extend it. Pass 1 inherits them as-is; pass 2 rewrites them to
            // point at the .d.ts files emitted by pass 1.
            const rootConfig = ts.readConfigFile(
                path.join(CWD, 'tsconfig.json'),
                ts.sys.readFile,
            ).config;
            const parsedConfig = ts.parseJsonConfigFileContent(rootConfig, ts.sys, CWD);

            // Pass 1 — emit.
            ts.createProgram([entrySrcPath], {
                ...parsedConfig.options,
                noEmit: false,
                declaration: true,
                emitDeclarationOnly: true,
                outDir: tempDtsDir,
            }).emit();

            // Pass 2 — bundle. dts-bundle-generator requires a real tsconfig path,
            // so this one stays on disk.
            fs.writeFileSync(
                tempBundleConfigPath,
                JSON.stringify({
                    extends: path.join(CWD, 'tsconfig.json'),
                    compilerOptions: {
                        lib: ['es2022', 'dom'],
                        paths: buildDtsPaths(tempDtsDir, rootConfig.compilerOptions.paths),
                    },
                }),
            );

            const inlinedLibraries = collectInlinedLibraries();
            const importedLibraries = [
                ...Object.keys(packageJson.peerDependencies),
                ...Object.keys(packageJson.dependencies),
            ].filter((name) => !inlinedLibraries.includes(name));
            const [result] = generateDtsBundle(
                [
                    {
                        filePath: entryDtsPath,
                        // `exportReferencedTypes: false` keeps internal types from
                        // `@datadog/browser-*` as `declare` rather than `export`,
                        // so they don't pollute our public API surface.
                        output: { noBanner: true, exportReferencedTypes: false },
                        libraries: { inlinedLibraries, importedLibraries },
                    },
                ],
                { preferredConfigPath: tempBundleConfigPath },
            );

            const outputPath = path.resolve(path.dirname(packageJson.main), 'index.d.ts');
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, result);
        } finally {
            fs.rmSync(tempDtsDir, { recursive: true, force: true });
        }
    },
});
