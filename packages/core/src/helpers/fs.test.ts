import { addFixtureFiles } from '@dd/tests/_jest/helpers/mocks';
import path from 'path';

import { checkFile } from './fs';

jest.mock('fs/promises', () => {
    const original = jest.requireActual('fs/promises');
    return {
        ...original,
        stat: jest.fn(),
    };
});

describe('checkFile', () => {
    beforeEach(() => {
        // Emulate some fixtures.
        addFixtureFiles({
            '/fixtures/empty.js': '',
            '/fixtures/not-empty.js': 'Not empty file',
        });
    });

    test.each([
        { filePath: '/fixtures/not-empty.js', expected: { exists: true, empty: false } },
        { filePath: '/fixtures/empty.js', expected: { exists: true, empty: true } },
        { filePath: '/fixtures/not-exist.js', expected: { exists: false, empty: false } },
    ])('Should return "$expected" for the file "$filePath".', async ({ filePath, expected }) => {
        const validity = await checkFile(path.resolve(__dirname, filePath));
        expect(validity).toEqual(expected);
    });
});
