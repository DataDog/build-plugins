// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    DEFAULT_RUNTIME_CPU_THROTTLING,
    DEFAULT_RUNTIME_LCP_SETTLE_MS,
    DEFAULT_RUNTIME_MAX_WAIT_MS,
    DEFAULT_RUNTIME_NETWORK,
    DEFAULT_RUNTIME_REPETITIONS,
    parseCpuThrottling,
    parseNetwork,
    parseRuntimeSettings,
} from './runtime-options';

const DEFAULTS = {
    cpuThrottling: DEFAULT_RUNTIME_CPU_THROTTLING,
    lcpSettleMs: DEFAULT_RUNTIME_LCP_SETTLE_MS,
    maxWaitMs: DEFAULT_RUNTIME_MAX_WAIT_MS,
    network: DEFAULT_RUNTIME_NETWORK,
    repetitions: DEFAULT_RUNTIME_REPETITIONS,
};

describe('canary runtime options', () => {
    test('should parse the defaults', () => {
        expect(parseRuntimeSettings(DEFAULTS)).toEqual({
            repetitions: 30,
            cpuThrottlingRates: [1],
            network: { downloadMbps: 40, uploadMbps: 10, latencyMs: 20 },
            lcpSettleMs: 8_000,
            maxWaitMs: 40_000,
            bootstrapResamples: 2_000,
        });
    });

    const networkCases = [
        { description: 'turn network throttling off', value: 'none', expected: null },
        {
            description: 'accept fractional speeds and no latency',
            value: '1.6:0.75:0',
            expected: { downloadMbps: 1.6, uploadMbps: 0.75, latencyMs: 0 },
        },
    ];

    test.each(networkCases)('should $description', ({ value, expected }) => {
        expect(parseNetwork(value)).toEqual(expected);
    });

    test('should accept several CPU rates', () => {
        expect(parseCpuThrottling('1,4')).toEqual([1, 4]);
    });

    const invalidCases = [
        {
            description: 'reject a network value with two parts',
            options: { network: '40:20' },
            error: '<download Mbps>',
        },
        {
            description: 'reject a network speed of 0',
            options: { network: '0:10:20' },
            error: 'more than 0',
        },
        {
            description: 'reject a CPU rate below 1',
            options: { cpuThrottling: '0.5' },
            error: 'at least 1',
        },
        {
            description: 'reject an empty CPU rate',
            options: { cpuThrottling: '1,' },
            error: 'at least 1',
        },
        {
            description: 'reject a repeated CPU rate',
            options: { cpuThrottling: '4,4' },
            error: 'twice',
        },
        {
            description: 'reject fewer than 3 repetitions',
            options: { repetitions: '2' },
            error: 'at least 3',
        },
        {
            description: 'reject fractional repetitions',
            options: { repetitions: '3.5' },
            error: 'whole number',
        },
        {
            description: 'reject a maximum wait within the settle wait',
            options: { lcpSettleMs: '8000', maxWaitMs: '8000' },
            error: 'longer than',
        },
    ];

    test.each(invalidCases)('should $description', ({ options, error }) => {
        const parse = () => parseRuntimeSettings({ ...DEFAULTS, ...options });
        expect(parse).toThrow(error);
    });
});
