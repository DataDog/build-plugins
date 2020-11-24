module.exports = {
    // Automatically clear mock calls and instances between every test
    clearMocks: true,
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ["**/__tests__/**/*.test.*"],
    globals: {
        'ts-jest': {
            tsConfig: 'tsconfig.json',
            packageJson: 'package.json',
        },
    },
    roots: ['./src'],
};
