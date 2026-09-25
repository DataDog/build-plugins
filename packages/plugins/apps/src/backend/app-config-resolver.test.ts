// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, readFileSync } from '@dd/core/helpers/fs';
import path from 'path';

import { APP_CONFIG_FILENAME, resolveAppConfigCredentialIds } from './app-config-resolver';

jest.mock('@dd/core/helpers/fs');

const mockExistsSync = jest.mocked(existsSync);
const mockReadFileSync = jest.mocked(readFileSync);

describe('resolveAppConfigCredentialIds', () => {
    const projectRoot = '/test/project/root';
    const uuid1 = '11111111-2222-3333-4444-555555555555';
    const uuid2 = '66666666-7777-8888-9999-000000000000';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns empty array when datadog-app.config.json does not exist', () => {
        mockExistsSync.mockReturnValue(false);

        const result = resolveAppConfigCredentialIds(projectRoot);

        expect(result).toEqual([]);
        const expectedConfigPath = path.join(projectRoot, APP_CONFIG_FILENAME);
        expect(mockExistsSync).toHaveBeenCalledWith(expectedConfigPath);
        expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    test('returns empty array when file read throws', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockImplementation(() => {
            throw new Error('EACCES');
        });

        const result = resolveAppConfigCredentialIds(projectRoot);

        expect(result).toEqual([]);
    });

    test('returns empty array when file is not valid JSON', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('{ malformed json');

        const result = resolveAppConfigCredentialIds(projectRoot);

        expect(result).toEqual([]);
    });

    test('returns empty array when customCredentialIds is absent', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify({ id: 'app-id', name: 'app' }));

        const result = resolveAppConfigCredentialIds(projectRoot);

        expect(result).toEqual([]);
    });

    test('returns empty array when customCredentialIds is not an array', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify({ customCredentialIds: 'not-an-array' }));

        const result = resolveAppConfigCredentialIds(projectRoot);

        expect(result).toEqual([]);
    });

    test('returns trimmed valid UUIDs, filtering out invalid values', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                customCredentialIds: [
                    `  ${uuid1.toUpperCase()}  `,
                    'not-a-uuid',
                    123,
                    null,
                    `\t${uuid2} `,
                ],
            }),
        );

        const result = resolveAppConfigCredentialIds(projectRoot);

        expect(result).toEqual([uuid1.toUpperCase(), uuid2]);
    });
});
