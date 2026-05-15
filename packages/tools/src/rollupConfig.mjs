// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// @ts-check

import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import esmShim from '@rollup/plugin-esm-shim';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import chalk from 'chalk';
import cp from 'child_process';
import fs from 'fs';
import { glob } from 'glob';
import modulePackage from 'module';
import os from 'os';
import path from 'path';
import esbuild from 'rollup-plugin-esbuild';

const CWD = process.env.PROJECT_CWD || process.cwd();
const ROLLUP_PLUGIN_PATH = 'rollup-plugin/dist-basic/src';
const BUNDLER_NAME_RX = /^@datadog\/(.+)-plugin$/g;

/**
 * @typedef {{
 *      module: string;
 *      main: string;
 *      name: string;
 *      peerDependencies: Record<string,string>;
 *      dependencies: Record<string,string>
 * }} PackageJson
 * @typedef {{ basic?: boolean }} BuildOptions
 * @typedef {import('rollup').InputPluginOption} InputPluginOption
 * @typedef {import('rollup').Plugin} Plugin
 * @typedef {import('@dd/core/types').Options} PluginOptions
 * @typedef {import('@dd/core/types').Assign<
 *      import('rollup').RollupOptions,
 *      {
 *         external?: string[];
 *         plugins?: InputPluginOption[];
 *      }
 * >} RollupOptions
 * @typedef {import('rollup').OutputOptions} OutputOptions
 */

/**
 * @param {PackageJson} packageJson
 * @param {RollupOptions} config
 * @returns {RollupOptions}
 */
export const bundle = (packageJson, config) => ({
    input: 'src/index.ts',
    ...config,
    external: [
        // All peer dependencies are external dependencies.
        ...Object.keys(packageJson.peerDependencies),
        // All dependencies are external dependencies.
        ...Object.keys(packageJson.dependencies),
        // These should be internal only and never be anywhere published.
        '@dd/tools',
        '@dd/tests',
        // We never want to include Node.js built-in modules in the bundle.
        ...modulePackage.builtinModules,
        ...(config.external || []),
    ],
    onwarn(warning, warn) {
        // Ignore warnings about undefined `this`.
        if (warning.code === 'THIS_IS_UNDEFINED') {
            return;
        }
        warn(warning);
    },
    plugins: [
        babel({
            babelHelpers: 'bundled',
            include: ['src/**/*'],
        }),
        json(),
        commonjs(),
        nodeResolve({ preferBuiltins: true }),
        ...(config.plugins || []),
    ],
});

/**
 * Returns the base configuration for the build plugin in the context of this project.
 * @param {string} bundlerName
 * @param {string} buildName
 * @returns {PluginOptions}
 */
const getPluginConfig = (bundlerName, buildName, addMetrics = false) => {
    const cleanBuildName = buildName.toLowerCase().replace(/@/g, '').replace(/[ /:]/g, '-');
    const packageName = `${bundlerName}-plugin`;
    const enableReports = !!process.env.BUILD_PLUGINS_REPORTS;
    return {
        auth: {
            apiKey: process.env.DATADOG_API_KEY,
        },
        logLevel: 'debug',
        metadata: {
            name: buildName,
        },
        output: { enable: enableReports, path: `../reports/${cleanBuildName}` },
        metrics: addMetrics
            ? {
                  tags: [
                      `build:${packageName}/${cleanBuildName}`,
                      'service:build-plugins',
                      `package:${packageName}`,
                      `bundler:rollup`,
                      `env:${process.env.BUILD_PLUGINS_ENV || 'development'}`,
                      `sha:${process.env.GITHUB_SHA || 'local'}`,
                      `ci:${process.env.CI ? 1 : 0}`,
                  ],
                  // NOTE: The current build is pretty small (2025-05-20). Keep an eye on the number of metrics submitted.
                  filters: [],
                  timestamp: Number(process.env.CI_PIPELINE_TIMESTAMP || Date.now()),
              }
            : undefined,
    };
};

/**
 * Returns the rollup build plugin instance if necessary, null otherwise.
 * If the rollup plugin is not found, it will build it first.
 * @returns {Promise<any | null>}
 */
const getDatadogPlugin = async () => {
    if (!process.env.ADD_BUILD_PLUGINS) {
        return null;
    }
    try {
        // Verify the file exists.
        if (!fs.existsSync(path.join(CWD, 'packages/published', ROLLUP_PLUGIN_PATH, 'index.js'))) {
            console.log('@datadog/rollup-plugin not found, building it...');
            // Build the rollup plugin first.
            /** @type {Promise<void>} */
            const buildProm = new Promise((resolve) => {
                cp.exec('yarn workspace @datadog/rollup-plugin buildBasic', { cwd: CWD }, (err) => {
                    if (err) {
                        console.error('Failed to build @datadog/rollup-plugin', err);
                    }
                    // Do not block the build for this.
                    resolve();
                });
            });

            await buildProm;
        }
        // We need to target the built file because we don't have TS support for rollup's configuration (yet).
        // eslint-disable-next-line import/no-unresolved
        const { datadogRollupPlugin } = await import(`@datadog/${ROLLUP_PLUGIN_PATH}`);
        // Type casting because of the difference of type provenance.
        return datadogRollupPlugin;
    } catch (e) {
        console.log('Could not load @datadog/rollup-plugin, skipping.', e);
    }
    return null;
};

/**
 * @param {PackageJson} packageJson
 * @param {Partial<OutputOptions>} overrides
 * @param {BuildOptions} [options]
 * @returns {OutputOptions}
 */
const getOutput = (packageJson, overrides = {}, options) => {
    const filename = overrides.format === 'esm' ? packageJson.module : packageJson.main;
    const plugins = [terser()];

    // Inject ESM shims to support __dirname and co.
    if (overrides.format === 'esm') {
        plugins.push(esmShim());
    }

    const outDir = options?.basic
        ? path.dirname(filename).replace(/\/dist\//g, '/dist-basic/')
        : path.dirname(filename);

    return {
        exports: 'named',
        sourcemap: true,
        entryFileNames: `[name]${path.extname(filename)}`,
        dir: outDir,
        plugins,
        format: 'cjs',
        globals: {
            globalThis: 'window',
        },
        // No chunks.
        manualChunks: () => '[name]',
        ...overrides,
    };
};

/**
 * Builds a `paths` mapping for workspace @dd/* packages, pointing to their TypeScript
 * source files. This makes TypeScript treat them as project files rather than external
 * libraries, so their declarations get emitted in the compilation pass.
 * @returns {Record<string, string[]>}
 */
const buildDdPaths = () => {
    const ddDir = path.join(CWD, 'node_modules/@dd');
    if (!fs.existsSync(ddDir)) {
        return {};
    }
    /** @type {Record<string, string[]>} */
    const paths = {};
    for (const name of fs.readdirSync(ddDir)) {
        let realPath;
        try {
            realPath = fs.realpathSync(path.join(ddDir, name));
        } catch {
            continue;
        }
        const pkgJsonPath = path.join(realPath, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
            continue;
        }
        let pkgExports;
        try {
            pkgExports = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')).exports;
        } catch {
            continue;
        }
        if (!pkgExports) {
            continue;
        }
        const relPath = path.relative(CWD, realPath).replace(/\\/g, '/');
        const packageName = `@dd/${name}`;
        // Map the main export: "." -> "./src/index.ts"
        if (typeof pkgExports['.'] === 'string') {
            paths[packageName] = [`${relPath}/${pkgExports['.'].slice(2)}`];
        }
        // Map the wildcard export: "./*" -> "./src/*.ts" becomes "@dd/name/*" -> ["rel/src/*"]
        if (typeof pkgExports['./*'] === 'string') {
            const srcWildcard = pkgExports['./*']
                .replace('./src/', `${relPath}/src/`)
                .replace('*.ts', '*');
            paths[`${packageName}/*`] = [srcWildcard];
        }
    }
    return paths;
};

/**
 * Converts a source-file paths map to the equivalent .d.ts paths map rooted in outDir.
 * Used to redirect dts-bundle-generator to pre-emitted declarations.
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
 *   Pass 1 — TypeScript API emits .d.ts for all workspace files WITHOUT DOM lib.
 *             No conflicts because workspace code is Node.js-only.
 *   Pass 2 — dts-bundle-generator runs against the emitted .d.ts files WITH DOM lib.
 *             Because all inputs are already .d.ts, dts-bundle-generator skips its own
 *             compilation pass (compile-dts.js line 143) and goes straight to the
 *             TypesUsageEvaluator, which needs DOM lib to resolve Window / EventTarget /
 *             XMLHttpRequest etc. referenced in @datadog/browser-* declarations.
 *
 * @param {PackageJson} packageJson
 * @returns {Plugin}
 */
const getDtsBundlePlugin = (packageJson) => {
    let generated = false;
    return {
        name: 'dts-bundle-generator',
        async closeBundle() {
            if (generated) {
                return;
            }
            generated = true;

            const { generateDtsBundle } = await import('dts-bundle-generator');
            const { default: ts } = await import('typescript');

            const safeName = packageJson.name.replace(/[^a-zA-Z0-9]/g, '-');
            const tempDtsDir = path.join(os.tmpdir(), `dts-tmp-${safeName}`);
            const tempEmitConfigPath = path.join(os.tmpdir(), `tsconfig.dts-emit-${safeName}.json`);
            const tempBundleConfigPath = path.join(os.tmpdir(), `tsconfig.dts-${safeName}.json`);

            const ddSrcPaths = buildDdPaths();

            // Symlink the project's node_modules so TypeScript can resolve external packages
            // (unplugin, webpack, etc.) from files emitted into the temp dir.
            fs.mkdirSync(tempDtsDir, { recursive: true });
            const tempNodeModulesLink = path.join(tempDtsDir, 'node_modules');
            if (!fs.existsSync(tempNodeModulesLink)) {
                fs.symlinkSync(path.join(CWD, 'node_modules'), tempNodeModulesLink);
            }

            // Pass 1: emit .d.ts for all workspace files reachable from the entry,
            // using the root tsconfig (lib: es2022, no DOM) so there are no conflicts.
            fs.writeFileSync(
                tempEmitConfigPath,
                JSON.stringify({
                    extends: path.join(CWD, 'tsconfig.json'),
                    compilerOptions: {
                        noEmit: false,
                        declaration: true,
                        emitDeclarationOnly: true,
                        outDir: tempDtsDir,
                        paths: ddSrcPaths,
                    },
                }),
            );

            const configFile = ts.readConfigFile(tempEmitConfigPath, ts.sys.readFile);
            const parsedConfig = ts.parseJsonConfigFileContent(
                configFile.config,
                ts.sys,
                CWD,
                {},
                tempEmitConfigPath,
            );
            const emitHost = ts.createCompilerHost(parsedConfig.options);
            const emitProgram = ts.createProgram(
                [path.resolve('src/index.ts')],
                parsedConfig.options,
                emitHost,
            );
            emitProgram.emit(undefined, undefined, undefined, true);

            // Pass 2: run dts-bundle-generator against the emitted .d.ts files.
            // DOM lib is needed for browser SDK types (Window, EventTarget, XMLHttpRequest …).
            // Because the entry is now a .d.ts file, dts-bundle-generator's
            // getDeclarationFiles detects allFilesAreDeclarations and skips its first
            // compilation pass — so DOM vs Node.js type conflicts never arise.
            const ddDtsPaths = buildDtsPaths(tempDtsDir, ddSrcPaths);

            const entryRelPath = path.relative(CWD, path.resolve('src/index.ts'));
            const entryDtsPath = path.join(tempDtsDir, entryRelPath.replace(/\.ts$/, '.d.ts'));

            fs.writeFileSync(
                tempBundleConfigPath,
                JSON.stringify({
                    extends: path.join(CWD, 'tsconfig.json'),
                    compilerOptions: {
                        lib: ['es2022', 'dom'],
                        paths: ddDtsPaths,
                    },
                }),
            );

            try {
                const outputPath = path.resolve(path.dirname(packageJson.main), 'index.d.ts');
                const inlinedLibraries = ['@datadog/browser-rum-core', '@datadog/browser-core'];
                const importedLibraries = [
                    ...Object.keys(packageJson.peerDependencies || {}),
                    ...Object.keys(packageJson.dependencies || {}),
                ].filter((name) => !inlinedLibraries.includes(name));
                const [result] = generateDtsBundle(
                    [
                        {
                            filePath: entryDtsPath,
                            output: { noBanner: true },
                            libraries: {
                                inlinedLibraries,
                                importedLibraries,
                            },
                        },
                    ],
                    { preferredConfigPath: tempBundleConfigPath },
                );

                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, result);
            } finally {
                for (const p of [tempEmitConfigPath, tempBundleConfigPath]) {
                    if (fs.existsSync(p)) {
                        fs.unlinkSync(p);
                    }
                }
                if (fs.existsSync(tempDtsDir)) {
                    fs.rmSync(tempDtsDir, { recursive: true, force: true });
                }
            }
        },
    };
};

/**
 * @param {any | null} ddPlugin
 * @param {PackageJson} packageJson
 * @param {BuildOptions} [options]
 * @returns {Promise<RollupOptions[]>}
 */
export const getSubBuilds = async (ddPlugin, packageJson, options) => {
    const bundlerName = packageJson.name.replace(BUNDLER_NAME_RX, '$1');
    // Verify if we have anything else to build from plugins.
    const pkgs = glob.sync('packages/plugins/**/package.json', { cwd: CWD });
    const subBuilds = [];
    for (const pkg of pkgs) {
        const { default: content } = await import(path.resolve(CWD, pkg), {
            with: { type: 'json' },
        });

        if (!content.toBuild) {
            continue;
        }

        console.log(
            `Will also build ${chalk.green.bold(content.name)} additional files: ${chalk.green.bold(Object.keys(content.toBuild).join(', '))}`,
        );

        subBuilds.push(
            ...Object.entries(content.toBuild).map(([name, config]) => {
                const outputs = (config.format ?? ['cjs']).map((format) =>
                    getOutput(
                        packageJson,
                        {
                            format,
                            sourcemap: false,
                            plugins: [terser({ mangle: true })],
                        },
                        options,
                    ),
                );
                const plugins = [esbuild()];
                if (ddPlugin) {
                    plugins.push(ddPlugin(getPluginConfig(bundlerName, name)));
                }
                return bundle(packageJson, {
                    plugins,
                    external: config.external,
                    input: {
                        [name]: path.join(CWD, path.dirname(pkg), config.entry),
                    },
                    output: outputs,
                });
            }),
        );
    }

    return subBuilds;
};

/**
 * @param {PackageJson} packageJson
 * @param {BuildOptions} [options]
 * @returns {Promise<RollupOptions[]>}
 */
export const getDefaultBuildConfigs = async (packageJson, options) => {
    const isBasicBuild = !!options?.basic;
    const ddPlugin = isBasicBuild ? null : await getDatadogPlugin();
    const bundlerName = packageJson.name.replace(BUNDLER_NAME_RX, '$1');

    // Plugins to use.
    const mainBundlePlugins = [esbuild()];
    if (ddPlugin) {
        mainBundlePlugins.push(ddPlugin(getPluginConfig(bundlerName, packageJson.name, true)));
    }
    if (!isBasicBuild && !process.env.NO_TYPES) {
        mainBundlePlugins.push(getDtsBundlePlugin(packageJson));
    }

    // Sub builds.
    const subBuilds = await getSubBuilds(ddPlugin, packageJson, options);

    // Main bundle.
    const mainBundleOutputs = [getOutput(packageJson, { format: 'cjs' }, options)];
    if (!isBasicBuild) {
        mainBundleOutputs.push(getOutput(packageJson, { format: 'esm' }, options));
    }
    const mainBundleConfig = bundle(packageJson, {
        plugins: mainBundlePlugins,
        input: {
            index: 'src/index.ts',
        },
        output: mainBundleOutputs,
    });

    return [mainBundleConfig, ...subBuilds];
};
