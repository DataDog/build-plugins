describe('Helpers', () => {
    test('It should use the moduleGraph API where availabled', () => {
        const { getModuleName } = require('../helpers');
        const mockModule1 = {
            issuer: {
                userRequest: 'moduleName',
            },
        };
        const mockModule2 = {
            moduleGraph: {
                issuer: {
                    userRequest: 'moduleName',
                },
            },
        };

        expect(getModuleName(mockModule1)).toBe(getModuleName(mockModule2));
    });
});
