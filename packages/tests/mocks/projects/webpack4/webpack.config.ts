// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import path from 'path';
import {BuildPlugin} from '@datadog/webpack-plugin';

// TODO type the config object.
const config = {
    context: __dirname,
    entry: {
        cheesecake: './src/file0000.js',
        yolo: './src/file0001.js',
    },
    plugins: [
        // @ts-ignore - TODO Compatibility between webpack 4 and 5.
        new BuildPlugin({
            output: './webpack-profile-debug',
        }),
    ],
    output: {
        path: path.join(__dirname, '/dist'),
        filename: '[name].js',
        chunkFilename: '[name].[contenthash].js',
    },
};

export default config;
