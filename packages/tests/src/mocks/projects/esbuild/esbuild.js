// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const { datadogEsbuildPlugin } = require('@datadog/esbuild-plugin');

require('esbuild')
    .build({
        bundle: true,
        entryPoints: {
            yolo: './src/file0001.js',
            cheesecake: './src/file0000.js',
        },
        outdir: './dist',
        plugins: [
            datadogEsbuildPlugin({
                auth: {
                    apiKey: '',
                },
                telemetry: {
                    output: './esbuild-profile-debug',
                },
            }),
        ],
    })
    .catch(() => {
        process.exitCode = 1;
    });
