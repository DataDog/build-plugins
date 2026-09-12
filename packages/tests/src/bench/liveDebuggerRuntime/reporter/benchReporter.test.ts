// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BenchFailure, BenchResultRow } from '../types';

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
        const comment = renderMarkdownComment([row], [], '7.4.0', {
            publishedAt: '2026-06-23T08:01:00.000Z',
            etag: 'W/"0766e1c8f7af8eceb34ea84386a51f37"',
        });
        const diagnosticsTable = buildAlignedTable([row]);
        const expectedComment = [
            '<!-- ld-runtime-bench -->',
            '## Live Debugger Runtime Benchmark',
            '',
            'SDK-loaded dormant-probe runtime overhead, measured against an uninstrumented bundle in the same browser session.',
            '',
            '| Browser | Workload | Quality | Per-call overhead upper |',
            '| --- | --- | --- | ---: |',
            '| chrome | Tiny | caution (outliers) | <= 0.05 ns |',
            '',
            '[What do the Tiny and Hot workloads represent?](https://github.com/DataDog/build-plugins/blob/master/packages/plugins/live-debugger/CONTRIBUTING.md#what-it-measures)',
            '',
            'Browser Debugger SDK: `7.4.0` · built 2026-06-23 · S3 ETag `0766e1c8`',
            '',
            '<details>',
            '<summary>Full diagnostics</summary>',
            '',
            '```',
            diagnosticsTable,
            '```',
            '',
            'Raw samples are in the `live-debugger-runtime-bench-results` artifact.',
            '',
            '</details>',
            '',
        ].join('\n');

        expect(comment).toBe(expectedComment);
    });

    test('should surface the raw samples artifact after benchmark failures', () => {
        const row = createBenchResultRow();
        const failure: BenchFailure = {
            projectName: 'safari',
            title: 'Measures SDK-loaded dormant runtime overhead',
            status: 'failed',
            error: 'Browser closed',
        };
        const comment = renderMarkdownComment([row], [failure]);
        const [details, afterDetails] = comment.split('</details>');
        const expectedAfterDetails = [
            '',
            '',
            '### Benchmark failures',
            '',
            '- **safari** (failed): Browser closed',
            '',
            'Raw samples are in the `live-debugger-runtime-bench-results` artifact.',
            '',
        ].join('\n');

        expect(details).not.toContain('Raw samples are in');
        expect(afterDetails).toBe(expectedAfterDetails);
    });

    test('should render the SDK version alone when no build fingerprint is available', () => {
        const row = createBenchResultRow();
        const comment = renderMarkdownComment([row], [], '7.4.0');

        expect(comment).toContain('Browser Debugger SDK: `7.4.0`');
        expect(comment).not.toContain('S3 ETag');
        expect(comment).not.toContain('built ');
    });
});
