describe('Tapables', () => {
    test('It should getContext with and without constructor', () => {
        const { Tapables } = require('../tapables');
        const tapables = new Tapables();

        const BasicClass: any = function BasicClass() {};
        const instance1 = new BasicClass();
        const instance2 = new BasicClass();
        instance2.constructor = null;

        expect(() => {
            tapables.getContext([instance1, instance2]);
        }).not.toThrow();
    });

    test('It should not crash with read-only hooks', () => {
        const { Tapables } = require('../tapables');
        const tapables = new Tapables();

        const mockTapable = {
            hooks: {
                hook1: Object.freeze({
                    tap: () => {},
                    tapAsync: () => {},
                    tapPromise: () => {},
                }),
            },
        };

        expect(() => {
            tapables.throughHooks(mockTapable);
        }).not.toThrow();
    });
});
