// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, readFileSync } from '@dd/core/helpers/fs';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import path from 'path';

import { APP_CONFIG_FILE } from '../app-identity';

import { resolveAppConfigCredentialIds } from './app-config-resolver';

jest.mock('@dd/core/helpers/fs');

const mockExistsSync = jest.mocked(existsSync);
const mockReadFileSync = jest.mocked(readFileSync);

describe('resolveAppConfigCredentialIds', () => {
    const projectRoot = '/test/project/root';
    const uuid1 = '11111111-2222-3333-4444-55555555abcd';
    const uuid2 = '66666666-7777-8888-9999-00000000ef01';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns empty array without warning when datadog-app.config.json does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        const logger = getMockLogger();

        const result = resolveAppConfigCredentialIds(projectRoot, logger);

        expect(result).toEqual([]);
        const expectedConfigPath = path.join(projectRoot, APP_CONFIG_FILE);
        expect(mockExistsSync).toHaveBeenCalledWith(expectedConfigPath);
        expect(mockReadFileSync).not.toHaveBeenCalled();
        expect(mockLogFn).not.toHaveBeenCalled();
    });

    test('warns and returns empty array when file read throws', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockImplementation(() => {
            throw new Error('EACCES');
        });
        const logger = getMockLogger();

        const result = resolveAppConfigCredentialIds(projectRoot, logger);

        expect(result).toEqual([]);
        const expectedWarning = expect.stringContaining(
            `Could not read ${APP_CONFIG_FILE}: EACCES`,
        );
        expect(mockLogFn).toHaveBeenCalledWith(expectedWarning, 'warn');
    });

    test('warns and returns empty array when file is not valid JSON', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('{ malformed json');
        const logger = getMockLogger();

        const result = resolveAppConfigCredentialIds(projectRoot, logger);

        expect(result).toEqual([]);
        const expectedWarning = expect.stringContaining(`Could not parse ${APP_CONFIG_FILE}`);
        expect(mockLogFn).toHaveBeenCalledWith(expectedWarning, 'warn');
    });

    test('warns and returns empty array when root value is not a JSON object', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('[]');
        const logger = getMockLogger();

        const result = resolveAppConfigCredentialIds(projectRoot, logger);

        expect(result).toEqual([]);
        const expectedWarning = expect.stringContaining(
            `Ignoring ${APP_CONFIG_FILE}: root value must be a JSON object.`,
        );
        expect(mockLogFn).toHaveBeenCalledWith(expectedWarning, 'warn');
    });

    test('returns empty array without warning when customCredentialIds is absent', () => {
        mockExistsSync.mockReturnValue(true);
        const configJson = JSON.stringify({ id: 'app-id', name: 'app' });
        mockReadFileSync.mockReturnValue(configJson);
        const logger = getMockLogger();

        const result = resolveAppConfigCredentialIds(projectRoot, logger);

        expect(result).toEqual([]);
        expect(mockLogFn).not.toHaveBeenCalled();
    });

    test('warns and returns empty array when customCredentialIds is not an array', () => {
        mockExistsSync.mockReturnValue(true);
        const configJson = JSON.stringify({ customCredentialIds: 'not-an-array' });
        mockReadFileSync.mockReturnValue(configJson);
        const logger = getMockLogger();

        const result = resolveAppConfigCredentialIds(projectRoot, logger);

        expect(result).toEqual([]);
        const expectedWarning = expect.stringContaining(
            `Ignoring customCredentialIds in ${APP_CONFIG_FILE}`,
        );
        expect(mockLogFn).toHaveBeenCalledWith(expectedWarning, 'warn');
    });

    test('returns trimmed lowercase valid UUIDs and warns about invalid values', () => {
        mockExistsSync.mockReturnValue(true);
        const configJson = JSON.stringify({
            customCredentialIds: [
                `  ${uuid1.toUpperCase()}  `,
                'not-a-uuid',
                123,
                null,
                `\t${uuid2} `,
            ],
        });
        mockReadFileSync.mockReturnValue(configJson);
        const logger = getMockLogger();

        const result = resolveAppConfigCredentialIds(projectRoot, logger);

        expect(result).toEqual([uuid1, uuid2]);
        const expectedWarning = expect.stringContaining(
            `Ignoring 3 invalid customCredentialIds entries in ${APP_CONFIG_FILE}`,
        );
        expect(mockLogFn).toHaveBeenCalledWith(expectedWarning, 'warn');
    });
});
