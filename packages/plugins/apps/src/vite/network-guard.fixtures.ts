// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { mkdirSync } from '@dd/core/helpers/fs';
import fs from 'fs';
import path from 'path';

// A run may write anywhere under the OS temp dir, so a probe that must be refused lives outside it,
// in the gitignored node_modules/.cache.
export function makeProbeDirOutsideTmp(prefix: string): string {
    const jestPackageJson = require.resolve('jest/package.json');
    const jestPackageDir = path.dirname(jestPackageJson);
    const nodeModules = path.dirname(jestPackageDir);
    const cacheRoot = path.join(nodeModules, '.cache');
    mkdirSync(cacheRoot);
    const probePrefix = path.join(cacheRoot, prefix);
    return fs.mkdtempSync(probePrefix);
}
