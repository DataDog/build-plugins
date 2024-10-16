// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fn from './src/file0000.js';
import fn2 from './workspaces/app/file0001.js';

// Add a third party dependency.
import * as chalk from 'chalk';

console.log(chalk.cyan('Hello world!'));

fn();
fn2();
