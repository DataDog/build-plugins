describe('Aggregator', () => {
    test('It should aggregate metrics without throwing.', () => {
        const { getMetrics } = require('../aggregator');
        const mockReport = {
            timings: {
                tapables: [],
                loaders: [],
            },
            dependencies: {},
        };
        const mockStats = {
            toJson: jest.fn(() => ({
                modules: [],
                chunks: [],
                assets: [],
                entrypoints: {},
                warnings: [],
                errors: [],
                time: 0,
            })),
        };
        const opts = { context: '', filters: [], tags: [] };
        expect(() => {
            getMetrics(mockReport, mockStats, opts);
        }).not.toThrow();
    });
});
