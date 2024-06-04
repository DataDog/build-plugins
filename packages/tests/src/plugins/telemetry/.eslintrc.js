module.exports = {
    overrides: [
        {
            files: ['mocks/**/*.*'],
            rules: {
                'func-names': 'off',
                'no-unused-expressions': 'off',
            },
        },
    ],
};
