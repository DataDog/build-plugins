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
// null (see node_modules/unplugin/dist/rspack/loaders/transform.js):
//
//   callback(null, res.code, map == null ? map : (res.map || map));
//
// rspack/webpack do not seed the loader chain with an input source map for a
// JavaScript entry that has no preceding loaders. Any plugin (this one
// included) that produces a source map from `transform` therefore needs at
// least one source-map-producing loader in front of it for the bundler to
// compose the map back to the original source. In real-world setups this is
// invariably a transpilation loader (`builtin:swc-loader`, `babel-loader`,
// `ts-loader`, ...). The test simulates that minimal precondition here.
const SHIM_LOADER_SOURCE = `
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

    it('produces line- and column-accurate sourcemaps after rspack', async () => {
        const entry = path.resolve(workingDir, 'live-debugger-entry.js');
        const outDir = path.resolve(workingDir, 'dist-live-debugger-rspack');
        const shimLoader = path.resolve(workingDir, 'identity-input-map-loader.cjs');

        outputFileSync(shimLoader, SHIM_LOADER_SOURCE);
        outputFileSync(
            entry,
            [
                'function helper() {',
                "    return 'helper';",
                '}',
                '',
                'function getDebuggerServicesStatus(isLoadingCritical) {',
                "    return isLoadingCritical ? 'loading' : 'completed';",
                '}',
                '',
                'getDebuggerServicesStatus(false);',
            ].join('\n'),
        );

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
        const traceMap = new TraceMap(sourceMap);
        const lines = bundle.split('\n');

        // The injected probe declaration carries the function id; the entry
        // call lands on a different generated line because the preamble is
        // multi-line. Both must resolve back to line 5 of the original
        // source — the function declaration line — even though they live on
        // different lines in the bundle.
        const probeDeclLine = lines.findIndex((line) =>
            line.includes('live-debugger-entry.js;getDebuggerServicesStatus'),
        );
        const entryCallLine = lines.findIndex(
            (line, idx) => idx > probeDeclLine && line.includes('$dd_entry($dd_p'),
        );
        expect(probeDeclLine).toBeGreaterThan(-1);
        expect(entryCallLine).toBeGreaterThan(-1);

        const probeDeclColumn = lines[probeDeclLine].indexOf(
            'live-debugger-entry.js;getDebuggerServicesStatus',
        );
        const entryCallColumn = lines[entryCallLine].indexOf('$dd_entry');

        expect(
            originalPositionFor(traceMap, {
                line: probeDeclLine + 1,
                column: probeDeclColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5 }));

        expect(
            originalPositionFor(traceMap, {
                line: entryCallLine + 1,
                column: entryCallColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5 }));

        // Original-source columns must also resolve correctly — `hires: true`
        // emits per-character mappings, so original code that the transform
        // leaves untouched (the function signature, the `return` body) must
        // still map back to its exact original column.
        const functionDeclLine = lines.findIndex((line) =>
            line.includes('function getDebuggerServicesStatus(isLoadingCritical)'),
        );
        const declColumn = lines[functionDeclLine].indexOf('function ');
        expect(
            originalPositionFor(traceMap, {
                line: functionDeclLine + 1,
                column: declColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5, column: 0 }));
    });
});
