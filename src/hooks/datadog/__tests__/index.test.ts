describe('Datadog Hook', () => {
    const buildPluginMock = {
        options: {},
    };
    const statsMock = {
        modules: [],
        chunks: [],
        assets: [],
        warnings: [],
        errors: [],
        entrypoints: {},
    };
    const reportMock = {
        timings: {
            tapables: {},
            loaders: {},
        },
        dependencies: {},
    };

    test('It should not fail given undefined options', async () => {
        // eslint-disable-next-line global-require
        const { hooks } = require('../index');
        const obj = await hooks.preoutput.call(buildPluginMock, {
            report: reportMock,
            stats: { toJson: () => statsMock },
        });

        expect(typeof obj).toBe('object');
    });
});
