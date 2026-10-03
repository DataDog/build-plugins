// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import { isBackendSourceModule, isPackageManagerModule } from './backend-sources';

const buildRoot = '/project';

describe('Backend Functions - isPackageManagerModule', () => {
    test.each([
        { modulePath: path.join('node_modules', '@datadog/apps-backend/index.js'), expected: true },
        { modulePath: path.join('..', '..', 'node_modules', 'pkg/index.js'), expected: true },
        { modulePath: path.join('.yarn', 'cache/pkg/index.js'), expected: true },
        { modulePath: path.join('src', 'node_modules_helper.ts'), expected: false },
        { modulePath: path.join('..', 'shared', 'actions.backend.ts'), expected: false },
    ])('Should return $expected for $modulePath', ({ modulePath, expected }) => {
        const isPackage = isPackageManagerModule(modulePath);
        expect(isPackage).toBe(expected);
    });
});

describe('Backend Functions - isBackendSourceModule', () => {
    test.each([
        {
            description: 'an app module',
            relativeFile: path.join('src', 'helper.ts'),
            expected: true,
        },
        {
            description: 'a module in a `..`-prefixed directory inside the root',
            relativeFile: path.join('..gen', 'helper.ts'),
            expected: true,
        },
        {
            description: 'a module outside the root',
            relativeFile: path.join('..', 'shared', 'helper.ts'),
            expected: false,
        },
        {
            description: 'a package dependency',
            relativeFile: path.join('node_modules', 'pkg', 'index.js'),
            expected: false,
        },
        {
            description: 'a non-code file',
            relativeFile: path.join('src', 'data.json'),
            expected: false,
        },
    ])('Should return $expected for $description', ({ relativeFile, expected }) => {
        const moduleId = path.join(buildRoot, relativeFile);
        const shouldTraverse = isBackendSourceModule(moduleId, buildRoot);
        expect(shouldTraverse).toBe(expected);
    });
});
