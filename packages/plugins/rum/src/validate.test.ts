import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';

import { validateOptions } from './validate';

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    getLogger: jest.fn(),
    time: jest.fn(),
};

describe('Test privacy plugin option exclude regex', () => {
    test('should exclude all files that start with special characters', () => {
        const options = validateOptions(
            { ...defaultPluginOptions, rum: { sdk: { applicationId: 'app_id' } } },
            mockLogger,
        );
        // test regex
        options.privacy?.exclude.forEach((regex) => {
            if (typeof regex === 'string') {
                return;
            }
            expect(regex.test('!test.js')).toBe(true);
            expect(regex.test('@test.js')).toBe(true);
            expect(regex.test('#test.js')).toBe(true);
            expect(regex.test('$test.js')).toBe(true);
            expect(regex.test('^test.js')).toBe(true);
        });
    });

    test('should include absolute and relative paths', () => {
        const options = validateOptions(
            { ...defaultPluginOptions, rum: { sdk: { applicationId: 'app_id' } } },
            mockLogger,
        );
        // test regex
        options.privacy?.exclude.forEach((regex) => {
            if (typeof regex === 'string') {
                return;
            }
            expect(regex.test('/Users/test/test.js')).toBe(true);
            expect(regex.test('./test.js')).toBe(true);
        });
    });

    test('should exclude node_modules', () => {
        const options = validateOptions(
            { ...defaultPluginOptions, rum: { sdk: { applicationId: 'app_id' } } },
            mockLogger,
        );
        options.privacy?.exclude.forEach((regex) => {
            if (typeof regex === 'string') {
                return;
            }
            expect(regex.test('/node_modules/test.js')).toBe(true);
        });
    });

    test('should exclude .preval files', () => {
        const options = validateOptions(
            { ...defaultPluginOptions, rum: { sdk: { applicationId: 'app_id' } } },
            mockLogger,
        );
        options.privacy?.exclude.forEach((regex) => {
            if (typeof regex === 'string') {
                return;
            }
            expect(regex.test('.preval.js')).toBe(true);
        });
    });
});
