// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJsonSync, readJsonSync } from '@dd/core/helpers/fs';
import { updateDependencies } from '@dd/tools/commands/integrity/dependencies';
import type { Workspace } from '@dd/tools/types';

jest.mock('@dd/tools/constants', () => ({
    ROOT: '/repo',
}));

jest.mock('@dd/core/helpers/fs', () => ({
    outputJsonSync: jest.fn(),
    readJsonSync: jest.fn(),
}));

const mockOutputJsonSync = jest.mocked(outputJsonSync);
const mockReadJsonSync = jest.mocked(readJsonSync);

const getWorkspace = (name: string): Workspace => ({
    name,
    slug: name.replace(/^@[^/]+\//, '').replace(/[^a-z0-9]+/g, '-'),
    location: `packages/${name.replace(/^@[^/]+\//, '')}`,
});

const mockPackageJsons = (packages: Record<string, Record<string, unknown>>) => {
    mockReadJsonSync.mockImplementation((filePath) => {
        const match = String(filePath).match(/\/repo\/(.+)\/package\.json$/);
        if (!match) {
            throw new Error(`Unexpected package path: ${filePath}`);
        }

        const pkg = packages[match[1]];
        if (!pkg) {
            throw new Error(`Missing package fixture for: ${match[1]}`);
        }

        return pkg;
    });
};

describe('updateDependencies', () => {
    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation();
    });

    test('writes package.json once when dependencies and optionalDependencies both change', async () => {
        const bundler = getWorkspace('@datadog/write-once-plugin');
        const internalDependency = getWorkspace('@dd/write-once-internal');

        mockPackageJsons({
            [bundler.location]: {
                dependencies: {
                    [internalDependency.name]: 'workspace:*',
                    extra: '1.0.0',
                },
                optionalDependencies: {
                    'old-optional': '1.0.0',
                },
            },
            [internalDependency.location]: {
                dependencies: {
                    required: '2.0.0',
                },
                optionalDependencies: {
                    optional: '3.0.0',
                },
            },
        });

        const errors = await updateDependencies([bundler, internalDependency], [bundler]);

        expect(errors).toEqual([]);
        expect(mockOutputJsonSync).toHaveBeenCalledTimes(1);
        expect(mockOutputJsonSync).toHaveBeenCalledWith(
            '/repo/packages/write-once-plugin/package.json',
            {
                dependencies: {
                    required: '2.0.0',
                },
                optionalDependencies: {
                    optional: '3.0.0',
                },
            },
        );
    });

    test('removes optionalDependencies when the expected record is empty', async () => {
        const bundler = getWorkspace('@datadog/remove-empty-plugin');
        const internalDependency = getWorkspace('@dd/remove-empty-internal');

        mockPackageJsons({
            [bundler.location]: {
                dependencies: {
                    [internalDependency.name]: 'workspace:*',
                },
                optionalDependencies: {
                    'old-optional': '1.0.0',
                },
            },
            [internalDependency.location]: {
                dependencies: {},
            },
        });

        const errors = await updateDependencies([bundler, internalDependency], [bundler]);

        expect(errors).toEqual([]);
        expect(mockOutputJsonSync).toHaveBeenCalledTimes(1);
        expect(mockOutputJsonSync).toHaveBeenCalledWith(
            '/repo/packages/remove-empty-plugin/package.json',
            {
                dependencies: {},
            },
        );
    });
});
