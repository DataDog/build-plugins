// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    buildIdentifier,
    getPackageJson,
    getRepositoryUrlFromPkg,
    resolveIdentifier,
    resolveRepositoryUrl,
} from '@dd/apps-plugin/identifier';
import { readFileSync } from '@dd/core/helpers/fs';
import { getClosestPackageJson } from '@dd/core/helpers/paths';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';

jest.mock('@dd/core/helpers/paths', () => ({
    getClosestPackageJson: jest.fn(),
}));

jest.mock('@dd/core/helpers/fs', () => ({
    readFileSync: jest.fn(),
}));

const getClosestPackageJsonMock = jest.mocked(getClosestPackageJson);
const readFileSyncMock = jest.mocked(readFileSync);

describe('Apps Plugin - identifier helpers', () => {
    const logger = getMockLogger();

    describe('getPackageJson', () => {
        test('Should read and parse the closest package.json', () => {
            getClosestPackageJsonMock.mockReturnValue('/root/project/package.json');
            readFileSyncMock.mockReturnValue('{ "name": "my-app" }');

            expect(getPackageJson('/root/project')).toEqual({ name: 'my-app' });
        });

        test('Should return undefined when no package.json is found', () => {
            getClosestPackageJsonMock.mockReturnValue(undefined);

            expect(getPackageJson('/root/project')).toBeUndefined();
            expect(getClosestPackageJsonMock).toHaveBeenCalledWith('/root/project');
            expect(readFileSyncMock).not.toHaveBeenCalled();
        });

        test('Should return undefined when package.json cannot be parsed', () => {
            getClosestPackageJsonMock.mockReturnValue('/root/project/package.json');
            readFileSyncMock.mockImplementation(() => {
                throw new Error('parse error');
            });

            expect(getPackageJson('/root/project')).toBeUndefined();
        });
    });

    describe('getRepositoryUrlFromPkg', () => {
        test('Should handle repository as string', () => {
            expect(getRepositoryUrlFromPkg({ repository: 'https://github.com/org/repo.git' })).toBe(
                'https://github.com/org/repo.git',
            );
        });

        test('Should handle repository as object', () => {
            expect(
                getRepositoryUrlFromPkg({
                    repository: { type: 'git', url: 'https://github.com/org/repo.git' },
                }),
            ).toBe('https://github.com/org/repo.git');
        });

        test('Should return undefined when no repository is provided', () => {
            expect(getRepositoryUrlFromPkg({})).toBeUndefined();
        });
    });

    describe('resolveRepositoryUrl', () => {
        test('Should prefer provided repository URL and sanitize it', () => {
            const result = resolveRepositoryUrl('git@github.com:org/repo.git');
            expect(result).toBe('git@github.com:org/repo');
        });

        test('Should fallback to repository in package.json', () => {
            const result = resolveRepositoryUrl(undefined, {
                repository: 'https://github.com/org/repo.git',
            });
            expect(result).toBe('https://github.com/org/repo');
        });

        test('Should return undefined when no repository can be resolved', () => {
            const result = resolveRepositoryUrl(undefined, {});
            expect(result).toBeUndefined();
        });
    });

    describe('buildIdentifier', () => {
        test('Should hash the combination of repository and name when both exist', () => {
            const result = buildIdentifier('https://github.com/org/repo', 'my-app');
            // The identifier should be a 32-character MD5 hash
            expect(result).toMatch(/^[a-f0-9]{32}$/);
            // Verify it's consistent
            expect(buildIdentifier('https://github.com/org/repo', 'my-app')).toBe(result);
        });

        test('Should produce different hashes for different inputs', () => {
            const hash1 = buildIdentifier('https://github.com/org/repo', 'my-app');
            const hash2 = buildIdentifier('https://github.com/org/repo', 'other-app');
            const hash3 = buildIdentifier('https://github.com/other/repo', 'my-app');

            expect(hash1).not.toBe(hash2);
            expect(hash1).not.toBe(hash3);
            expect(hash2).not.toBe(hash3);
        });

        test('Should require both repository and name', () => {
            expect(buildIdentifier('https://github.com/org/repo', undefined)).toBeUndefined();
            expect(buildIdentifier(undefined, 'my-app')).toBeUndefined();
            expect(buildIdentifier(undefined, undefined)).toBeUndefined();
        });
    });

    describe('resolveIdentifier', () => {
        test('Should compute the identifier from git remote and package name', () => {
            getClosestPackageJsonMock.mockReturnValue('/root/project/package.json');
            readFileSyncMock.mockReturnValue(
                JSON.stringify({
                    name: 'my-app',
                }),
            );

            const id = resolveIdentifier(
                '/root/project',
                logger,
                'git@github.com:datadog/my-app.git',
            );

            // Should return a 32-character MD5 hash
            expect(id).toMatch(/^[a-f0-9]{32}$/);
            expect(mockLogFn).not.toHaveBeenCalled();
        });

        test('Should pick repository from package.json when remote is missing', () => {
            getClosestPackageJsonMock.mockReturnValue('/root/project/package.json');
            readFileSyncMock.mockReturnValue(
                JSON.stringify({
                    name: 'app-name',
                    repository: {
                        type: 'git',
                        url: 'https://github.com/org/repo.git',
                    },
                }),
            );

            const id = resolveIdentifier('/root/project', logger);
            // Should return a 32-character MD5 hash
            expect(id).toMatch(/^[a-f0-9]{32}$/);
            expect(mockLogFn).not.toHaveBeenCalled();
        });

        test('Should log errors when unable to compute an identifier', () => {
            getClosestPackageJsonMock.mockReturnValue(undefined);

            const id = resolveIdentifier('/root/project', logger);

            expect(id).toBeUndefined();
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('No package.json found'),
                'warn',
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Unable to determine the app name'),
                'error',
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Unable to determine the git remote'),
                'error',
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Unable to compute the app identifier'),
                'error',
            );
        });
    });
});
