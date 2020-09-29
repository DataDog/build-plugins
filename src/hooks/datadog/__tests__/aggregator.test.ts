import { mockReport, mockStats } from '../../../__tests__/testHelpers.ignore';

describe('Aggregator', () => {
    test('It should aggregate metrics without throwing.', () => {
        const { getMetrics } = require('../aggregator');
        const opts = { context: '', filters: [], tags: [] };
        expect(() => {
            getMetrics(mockReport, mockStats, opts);
        }).not.toThrow();
    });
});
