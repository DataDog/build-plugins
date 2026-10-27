// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
import os from 'os';
import path from 'path';

import type { NodeRelease } from './toolchain';
import {
    formatToolchainEnvironment,
    parseNodeReleases,
    parsePackageManager,
    readNodeVersionSpec,
    resolveNodeVersion,
} from './toolchain';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-toolchain-${process.pid}`);

// Deliberately not sorted, like nothing guarantees the real index to be.
const RELEASES: NodeRelease[] = [
    { version: 'v24.13.0', lts: 'Krypton' },
    { version: 'v25.1.0', lts: false },
    { version: 'v22.22.0', lts: 'Jod' },
    { version: 'v24.14.1', lts: 'Krypton' },
    { version: 'v22.9.0', lts: false },
];

describe('canary toolchain', () => {
    beforeEach(async () => {
        await rm(TEST_ROOT);
    });

    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    const specCases = [
        {
            description: 'read .nvmrc and drop a leading "v"',
            files: { '.nvmrc': 'v24.14.1\n', 'package.json': '{}' },
            fallback: undefined,
            expected: { spec: '24.14.1', source: '.nvmrc' },
        },
        {
            description: 'skip comments in .nvmrc',
            files: { '.nvmrc': '# Node.js LTS\nlts/jod # current LTS\n', 'package.json': '{}' },
            fallback: undefined,
            expected: { spec: 'lts/jod', source: '.nvmrc' },
        },
        {
            description: 'prefer .node-version over volta.node',
            files: {
                '.node-version': '22.11.0',
                'package.json': '{ "volta": { "node": "24.14.1" } }',
            },
            fallback: 'lts/*',
            expected: { spec: '22.11.0', source: '.node-version' },
        },
        {
            description: 'read volta.node from package.json',
            files: { 'package.json': '{ "volta": { "node": "24.14.1" } }' },
            fallback: 'lts/*',
            expected: { spec: '24.14.1', source: 'package.json volta.node' },
        },
        {
            description: "fall back to the target's Node.js version",
            files: { 'package.json': '{ "engines": { "node": ">=18" } }' },
            fallback: 'lts/*',
            expected: { spec: 'lts/*', source: 'target definition' },
        },
    ];

    test.each(specCases)('should $description', async ({ files, fallback, expected }) => {
        for (const [fileName, content] of Object.entries(files)) {
            const filePath = path.resolve(TEST_ROOT, fileName);
            await outputFile(filePath, content);
        }

        const spec = await readNodeVersionSpec(TEST_ROOT, fallback);

        expect(spec).toEqual(expected);
    });

    test('should fail when neither the checkout nor the target pins Node.js', async () => {
        const packageJsonPath = path.resolve(TEST_ROOT, 'package.json');
        await outputFile(packageJsonPath, '{}');

        const promise = readNodeVersionSpec(TEST_ROOT, undefined);

        await expect(promise).rejects.toThrow('pins no Node.js version');
    });

    const versionCases = [
        { description: 'resolve a major version', spec: '24', expected: '24.14.1' },
        { description: 'resolve an older major version', spec: '22', expected: '22.22.0' },
        { description: 'resolve a minor version', spec: '24.13', expected: '24.13.0' },
        { description: 'resolve the newest LTS', spec: 'lts/*', expected: '24.14.1' },
        { description: 'resolve an LTS codename', spec: 'lts/Jod', expected: '22.22.0' },
        { description: 'resolve the newest release', spec: 'node', expected: '25.1.0' },
    ];

    test.each(versionCases)('should $description', async ({ spec, expected }) => {
        const version = await resolveNodeVersion(spec, async () => RELEASES);

        expect(version).toBe(expected);
    });

    test('should keep an exact version without fetching the release index', async () => {
        const getReleases = jest.fn(async () => RELEASES);

        const version = await resolveNodeVersion('24.14.1', getReleases);

        expect(version).toBe('24.14.1');
        expect(getReleases).not.toHaveBeenCalled();
    });

    const versionErrorCases = [
        { description: 'reject an unknown LTS codename', spec: 'lts/argon', error: 'No Node.js' },
        { description: 'reject an unsupported alias', spec: 'iojs', error: 'Unsupported' },
    ];

    test.each(versionErrorCases)('should $description', async ({ spec, error }) => {
        const promise = resolveNodeVersion(spec, async () => RELEASES);

        await expect(promise).rejects.toThrow(error);
    });

    test('should reject a malformed release index', () => {
        const parse = () => parseNodeReleases([{ version: 'v24.14.1', lts: 1 }]);

        expect(parse).toThrow('unexpected entry');
    });

    const packageManagerCases = [
        {
            description: 'install Yarn 6 with Yarn Switch',
            packageManager: 'yarn@6.0.0-rc.23',
            expected: { name: 'yarn', version: '6.0.0-rc.23', installer: 'yarn-switch' },
        },
        {
            description: 'install Yarn 1 with Corepack',
            packageManager: 'yarn@1.22.22',
            expected: { name: 'yarn', version: '1.22.22', installer: 'corepack' },
        },
        {
            description: 'drop the integrity suffix',
            packageManager: 'yarn@4.10.3+sha512.0123abcd',
            expected: { name: 'yarn', version: '4.10.3', installer: 'corepack' },
        },
        {
            description: 'install pnpm with Corepack',
            packageManager: 'pnpm@9.15.0',
            expected: { name: 'pnpm', version: '9.15.0', installer: 'corepack' },
        },
    ];

    test.each(packageManagerCases)('should $description', ({ packageManager, expected }) => {
        const parsed = parsePackageManager({ packageManager });

        expect(parsed).toEqual(expected);
    });

    const packageManagerErrorCases = [
        { description: 'require a packageManager field', packageJson: {}, error: 'declares no' },
        {
            description: 'reject an unknown package manager',
            packageJson: { packageManager: 'bun@1.1.0' },
            error: 'Unsupported packageManager',
        },
    ];

    test.each(packageManagerErrorCases)('should $description', ({ packageJson, error }) => {
        const parse = () => parsePackageManager(packageJson);

        expect(parse).toThrow(error);
    });

    test('should format the toolchain for the CI job script', () => {
        const environment = formatToolchainEnvironment(
            {
                node: { version: '24.14.1', source: '.nvmrc' },
                packageManager: { name: 'yarn', version: '6.0.0-rc.23', installer: 'yarn-switch' },
            },
            '0123abcd',
        );

        const expected = [
            'CANARY_TARGET_COMMIT=0123abcd',
            'CANARY_NODE_VERSION=24.14.1',
            'CANARY_PACKAGE_MANAGER=yarn',
            'CANARY_PACKAGE_MANAGER_VERSION=6.0.0-rc.23',
            'CANARY_PACKAGE_MANAGER_INSTALLER=yarn-switch',
            '',
        ].join('\n');
        expect(environment).toBe(expected);
    });
});
