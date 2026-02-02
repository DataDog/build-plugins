// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// project/main1.js

import fn from './src/srcFile0.js';
import fn2 from './workspaces/app/workspaceFile1.js';

// Add a third party dependency.
import * as chalk from 'chalk';

console.log(chalk.cyan('Hello World!'));

fn();
fn2();

import('./src/dynamicChunk.js').then((module) => {
    module.dynamicChunkFunction();
});
