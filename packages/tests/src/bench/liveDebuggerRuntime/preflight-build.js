// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */

// Standalone Rspack build for the preflight output hash. Kept as a real file
// (invoked as `node preflight-build.js <fixturePath> <bundler>`) rather than an
// inline `node -e` string so the build config stays lintable and the live
// debugger options can be shared with the benchmark.

const path = require('path');

const { datadogRspackPlugin } = require('@datadog/rspack-plugin/dist/src');
const { rspack } = require('@rspack/core');

const { getLiveDebuggerBenchConfig } = require('./liveDebuggerBenchConfig');

const fixturePath = process.argv[2];
const bundler = process.argv[3];

if (!fixturePath || !bundler) {
    console.error('Usage: node preflight-build.js <fixturePath> <bundler>');
    process.exit(1);
}

const plugin = datadogRspackPlugin({
    auth: { apiKey: '123', appKey: '123' },
    metadata: { name: path.basename(fixturePath) },
    liveDebugger: getLiveDebuggerBenchConfig(true),
});

const config = {
    context: fixturePath,
    entry: { [bundler]: path.resolve(fixturePath, 'instrumented.js') },
    experiments: {
        css: true,
    },
    mode: 'none',
    output: {
        path: path.resolve(fixturePath, 'dist'),
        filename: '[name].js',
        chunkFilename: 'chunk.[contenthash].js',
    },
    devtool: 'source-map',
    optimization: {
        minimize: false,
    },
    plugins: [plugin],
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
        rules: [{ test: /\.([cm]?ts|tsx)$/, loader: 'ts-loader' }],
    },
};

rspack(config, (error, stats) => {
    if (error) {
        console.error(error);
        process.exit(1);
    }

    if (!stats) {
        console.error('No Rspack stats returned.');
        process.exit(1);
    }

    if (stats.hasErrors()) {
        const info = stats.toJson();
        console.error((info.errors || []).join('\n'));
        process.exit(1);
    }
});
