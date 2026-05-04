// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { outputFileSync, readFileSync, rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { buildWithRspack } from '@dd/tools/bundlers';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import path from 'path';

// Tiny rspack/webpack loader that publishes an identity source map for the
// modules it touches. It is required because unplugin's rspack/webpack
// transform loader silently drops `res.map` when the *input* source map is
// null.
const IDENTITY_SHIM_LOADER_SOURCE = `
module.exports = function (source) {
    this.cacheable && this.cacheable();
    const callback = this.async();
    const lines = source.split('\\n');
    const mappings = lines
        .map((_, idx) => (idx === 0 ? 'AAAA' : 'AACA'))
        .join(';');
    callback(null, source, {
        version: 3,
        sources: [this.resourcePath],
        sourcesContent: [source],
        names: [],
        mappings: mappings,
    });
};
`;

const BANNER_LINES = 4;
const BANNER_SHIFT_SHIM_LOADER_SOURCE = `
const BANNER = ${JSON.stringify('// banner\n'.repeat(BANNER_LINES))};
module.exports = function (source) {
    this.cacheable && this.cacheable();
    const callback = this.async();
    const lines = source.split('\\n');
    // Identity-by-line mappings for the original source, prefixed with
    // ${BANNER_LINES} empty entries for the banner lines (which have no
    // original source position).
    const sourceMappings = lines
        .map((_, idx) => (idx === 0 ? 'AAAA' : 'AACA'))
        .join(';');
    const mappings = ';'.repeat(${BANNER_LINES}) + sourceMappings;
    callback(null, BANNER + source, {
        version: 3,
        sources: [this.resourcePath],
        sourcesContent: [source],
        names: [],
        mappings: mappings,
    });
};
`;

describe('Live Debugger sourcemaps', () => {
    const seed = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
    let workingDir: string;

    beforeAll(async () => {
        workingDir = await prepareWorkingDir(seed);
    });

    afterAll(async () => {
        if (!process.env.NO_CLEANUP) {
            await rm(workingDir);
        }
    });

    const ENTRY_SOURCE = [
        'function helper() {',
        "    return 'helper';",
        '}',
        '',
        'function getDebuggerServicesStatus(isLoadingCritical) {',
        "    return isLoadingCritical ? 'loading' : 'completed';",
        '}',
        '',
        'getDebuggerServicesStatus(false);',
    ].join('\n');

    /**
     * Build the entry through rspack with the live-debugger plugin enabled and
     * the given upstream loader, then return the bundle, its source map, and
     * a few key positions used by every assertion below. Centralizing this
     * keeps the actual test bodies focused on the source-map invariants they
     * are checking and avoids re-stating the bundler config in every case.
     */
    const buildAndLocate = async (upstreamShimLoaderSource: string, outputSubdir: string) => {
        const entry = path.resolve(workingDir, 'live-debugger-entry.js');
        const outDir = path.resolve(workingDir, outputSubdir);
        const shimLoader = path.resolve(workingDir, `${outputSubdir}-loader.cjs`);

        outputFileSync(shimLoader, upstreamShimLoaderSource);
        outputFileSync(entry, ENTRY_SOURCE);

        const { errors } = await buildWithRspack({
            context: workingDir,
            mode: 'none',
            devtool: 'source-map',
            entry: { main: entry },
            output: {
                path: outDir,
                filename: '[name].js',
            },
            resolve: {
                extensions: ['.js'],
            },
            module: {
                // Stand-in for the source-map-producing loader (swc/babel/ts/...)
                // that would normally precede the Datadog plugin in a real build.
                rules: [{ test: /\.js$/, use: [{ loader: shimLoader }] }],
            },
            plugins: [
                datadogRspackPlugin({
                    ...defaultPluginOptions,
                    liveDebugger: {
                        enable: true,
                    },
                    metadata: {
                        version: 'test-version',
                    },
                }),
            ],
        });

        expect(errors).toEqual([]);

        const bundle = readFileSync(path.resolve(outDir, 'main.js'));
        const sourceMap = JSON.parse(readFileSync(path.resolve(outDir, 'main.js.map')));
        const lines = bundle.split('\n');

        const probeDeclLine = lines.findIndex((line) =>
            line.includes('live-debugger-entry.js;getDebuggerServicesStatus'),
        );
        const entryCallLine = lines.findIndex(
            (line, idx) => idx > probeDeclLine && line.includes('$dd_entry($dd_p'),
        );
        const functionDeclLine = lines.findIndex((line) =>
            line.includes('function getDebuggerServicesStatus(isLoadingCritical)'),
        );

        expect(probeDeclLine).toBeGreaterThan(-1);
        expect(entryCallLine).toBeGreaterThan(-1);
        expect(functionDeclLine).toBeGreaterThan(-1);

        return {
            traceMap: new TraceMap(sourceMap),
            probeDeclLine,
            probeDeclColumn: lines[probeDeclLine].indexOf(
                'live-debugger-entry.js;getDebuggerServicesStatus',
            ),
            entryCallLine,
            entryCallColumn: lines[entryCallLine].indexOf('$dd_entry'),
            functionDeclLine,
            functionDeclColumn: lines[functionDeclLine].indexOf('function '),
        };
    };

    it('produces line- and column-accurate sourcemaps after rspack', async () => {
        const located = await buildAndLocate(
            IDENTITY_SHIM_LOADER_SOURCE,
            'dist-live-debugger-rspack-identity',
        );

        expect(
            originalPositionFor(located.traceMap, {
                line: located.probeDeclLine + 1,
                column: located.probeDeclColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5 }));

        expect(
            originalPositionFor(located.traceMap, {
                line: located.entryCallLine + 1,
                column: located.entryCallColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5 }));

        expect(
            originalPositionFor(located.traceMap, {
                line: located.functionDeclLine + 1,
                column: located.functionDeclColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5, column: 0 }));
    });

    it('composes its source map with the previous loader so injected positions are reported in original-source coordinates', async () => {
        const located = await buildAndLocate(
            BANNER_SHIFT_SHIM_LOADER_SOURCE,
            'dist-live-debugger-rspack-shifted',
        );

        const probeDeclResolved = originalPositionFor(located.traceMap, {
            line: located.probeDeclLine + 1,
            column: located.probeDeclColumn,
        });
        const entryCallResolved = originalPositionFor(located.traceMap, {
            line: located.entryCallLine + 1,
            column: located.entryCallColumn,
        });
        const functionDeclResolved = originalPositionFor(located.traceMap, {
            line: located.functionDeclLine + 1,
            column: located.functionDeclColumn,
        });

        // Every position we care about must point at line 5 of the original
        // source, NOT line 5 + BANNER_LINES of the post-loader buffer.
        expect(probeDeclResolved).toEqual(expect.objectContaining({ line: 5 }));
        expect(entryCallResolved).toEqual(expect.objectContaining({ line: 5 }));
        expect(functionDeclResolved).toEqual(expect.objectContaining({ line: 5, column: 0 }));

        // Defensive: explicitly assert that none of the resolved positions
        // are pointing at the banner area. Without composition the injected
        // probe positions would land on lines 5..(5 + BANNER_LINES) of what
        // the bundler thinks is the original source.
        for (const resolved of [probeDeclResolved, entryCallResolved, functionDeclResolved]) {
            expect(resolved.line).not.toBeGreaterThan(5);
        }
    });
});
