module.exports = {
    // Automatically clear mock calls and instances between every test
    clearMocks: true,
    preset: 'ts-jest',
    testEnvironment: 'node',
    globals: {
        'ts-jest': {
            tsConfig: 'tsconfig.json',
        },
    },
    testPathIgnorePatterns: ['.+\\.ignore\\.+'],
    roots: ['./src'],
};
