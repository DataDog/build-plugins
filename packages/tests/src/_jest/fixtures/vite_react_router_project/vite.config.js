// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogVitePlugin } from '@datadog/vite-plugin';
import react from '@vitejs/plugin-react-swc';
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [
        datadogVitePlugin({
            enableGit: false,
            auth: {
                apiKey: process.env.DATADOG_API_KEY || 'fake-api-key',
            },
            rum: {
                sourcemaps: {
                    bailOnError: true,
                    releaseVersion: `app@vite`,
                    service: 'x',
                    minifiedPathPrefix: '/static',
                },
            },
            logLevel: 'debug',
            output: {},
            metrics: { enable: false }
        }),
        react(),
        reactRouter(),
    ],
    build: {
        outDir: 'dist',
        sourcemap: false,
    },
});
