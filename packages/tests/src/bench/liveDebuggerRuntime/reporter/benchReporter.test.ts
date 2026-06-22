// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BenchResultRow } from '../types';

import { buildAlignedTable, renderMarkdownComment } from './benchReporter';

const createBenchResultRow = (): BenchResultRow => {
    return {
        browserName: 'chrome',
        workloadId: 'tiny',
        workloadLabel: 'Tiny',
        batchSize: 1_000,
        instrumentedCallsPerBatch: 1_000,
        baseline: {
            samplesMs: [1],
            medianMs: 1.2345,
        },
        control: {
            samplesMs: [1],
            medianMs: 1.2345,
        },
        instrumented: {
            samplesMs: [2],
            medianMs: 2.3456,
        },
        perCallNs: {
            point: 1,
            direct: {
                low: -0.04,
                high: 0.03,
            },
            block: {
                low: -0.05,
                high: 0.04,
            },
            aaFloor: {
                low: -0.03,
                high: 0.03,
            },
            upperBound: 0.05,
        },
        overheadUpperPercent: 1.23,
        sampleCount: 30,
        trimFraction: 0.2,
        outlierFraction: 0.1,
        lag1Autocorrelation: 0.01,
        quality: { level: 'caution', reasons: ['outliers'] },
    };
};

describe('Live Debugger runtime benchmark reporter', () => {
    test('should render CLI diagnostics with units in row values', () => {
        const row = createBenchResultRow();
        const table = buildAlignedTable([row]);
        const header = table.split('\n')[0];
        const headerCells = header.trim().split(/\s{2,}/);

        expect(headerCells).toEqual([
            'browser',
            'workload',
            'quality',
            'per-call overhead upper',
            'overhead upper',
            '95% CI',
            'A/A diag',
            'block CI',
            'acf(1)',
            'baseline',
            'instrumented',
            'samples',
        ]);
        expect(table).toContain('chrome   Tiny      caution (outliers)');
        expect(table).toContain('<= 0.05 ns');
        expect(table).toContain('<= 1.23%');
        expect(table).toContain('-0.04..0.03 ns');
        expect(table).toContain('1.235 ms');
        expect(table).toContain('2.346 ms');
    });

    test('should render GitHub comment summary and diagnostics', () => {
        const row = createBenchResultRow();
        const comment = renderMarkdownComment([row], []);
        const summary = comment.split('<details>')[0];

        expect(comment).toContain(
            'SDK-loaded dormant-probe runtime overhead, measured against an uninstrumented bundle in the same browser session.',
        );
        expect(comment).toContain('| Browser | Workload | Quality | Per-call overhead upper |');
        expect(comment).toContain('<summary>Full diagnostics</summary>');
        expect(comment).toContain('| chrome | Tiny | caution (outliers) | <= 0.05 ns |');
        expect(summary).not.toContain('<= 1.23%');
        expect(summary).not.toContain('| overhead upper |');
        expect(comment).toContain('1.235 ms');
        expect(comment).toContain('-0.04..0.03 ns');
        expect(comment).toContain('<= 1.23%');
        expect(comment).toContain('overhead upper');
    });
});
