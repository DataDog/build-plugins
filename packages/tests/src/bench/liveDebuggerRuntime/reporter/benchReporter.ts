// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFileSync, readFileSync } from '@dd/core/helpers/fs';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import os from 'os';
import path from 'path';

import type {
    BenchFailure,
    BenchResultRow,
    MetricUnit,
    RawBenchAttachment,
    RawVariantResult,
    RawWorkloadResult,
    SdkBuild,
} from '../types';

import {
    BOOTSTRAP_ITERATIONS,
    TRIM_FRACTION,
    bcaConfidenceInterval,
    bcaIndexConfidenceInterval,
    getQuality,
    hashString,
    lag1Autocorrelation,
    madOutlierFraction,
    movingBlockBootstrapConfidenceInterval,
    movingBlockIndexBootstrapConfidenceInterval,
    overheadUpperBound,
    pick,
    trimmedMean,
} from './stats';

const ATTACHMENT_NAME = 'live-debugger-runtime-bench';
const COMMENT_MARKER = '<!-- ld-runtime-bench -->';
const COMMENT_FILE = path.resolve(os.tmpdir(), 'live-debugger-runtime-bench-comment.md');

const buildResultsFilePath = (generatedAt: string) => {
    const safeTimestamp = generatedAt.replace(/[:.]/g, '-');
    return path.resolve(os.tmpdir(), `live-debugger-runtime-bench-results-${safeTimestamp}.json`);
};

const parseAttachmentBody = (result: TestResult): RawBenchAttachment[] => {
    const attachments = result.attachments.filter(
        (attachment) => attachment.name === ATTACHMENT_NAME,
    );
    const parsedAttachments: RawBenchAttachment[] = [];

    for (const attachment of attachments) {
        if (attachment.body) {
            parsedAttachments.push(JSON.parse(attachment.body.toString()));
        } else if (attachment.path) {
            const fileContent = readFileSync(attachment.path);
            parsedAttachments.push(JSON.parse(fileContent));
        }
    }

    return parsedAttachments;
};

const getSampleDeltasMs = (left: RawVariantResult, right: RawVariantResult) => {
    return left.samplesMs.map((sample, index) => {
        return sample - right.samplesMs[index];
    });
};

const getBlockLength = (sampleCount: number) => {
    return Math.max(1, Math.round(Math.sqrt(sampleCount)));
};

const toRatioPercent = (deltasMs: number[], baselineSamplesMs: number[]) => {
    const baselineLevelMs = trimmedMean(baselineSamplesMs, TRIM_FRACTION);

    if (baselineLevelMs <= 0) {
        return 0;
    }

    return (trimmedMean(deltasMs, TRIM_FRACTION) / baselineLevelMs) * 100;
};

type MetricEstimate = Omit<MetricUnit, 'upperBound'>;

const withUpperBound = (estimate: MetricEstimate): MetricUnit => {
    return {
        ...estimate,
        upperBound: overheadUpperBound(estimate.direct, estimate.block),
    };
};

const mapMetricUnit = (unit: MetricEstimate, mapper: (value: number) => number): MetricUnit => {
    const direct = {
        low: mapper(unit.direct.low),
        high: mapper(unit.direct.high),
    };
    const block = {
        low: mapper(unit.block.low),
        high: mapper(unit.block.high),
    };

    return withUpperBound({
        point: mapper(unit.point),
        direct,
        block,
        aaFloor: {
            low: mapper(unit.aaFloor.low),
            high: mapper(unit.aaFloor.high),
        },
    });
};

type SeedFor = (suffix: string) => number;

// Per-call overhead in ns: a 20% trimmed mean of `instrumented - control` with
// a naive (BCa) and dependence-robust (moving-block) interval, plus the
// `control - baseline` A/A floor, all rescaled from ms-per-batch to ns-per-call.
const buildPerCallNsMetric = (
    directDeltasMs: number[],
    aaDeltasMs: number[],
    instrumentedCallsPerBatch: number,
    blockLength: number,
    seedFor: SeedFor,
): MetricUnit => {
    const toNsPerCall = (valueMs: number) => {
        return (valueMs * 1_000_000) / instrumentedCallsPerBatch;
    };
    const directSeed = seedFor('');
    const blockSeed = seedFor(':block');
    const aaSeed = seedFor(':control');
    const msMetric: MetricEstimate = {
        point: trimmedMean(directDeltasMs, TRIM_FRACTION),
        direct: bcaConfidenceInterval(directDeltasMs, BOOTSTRAP_ITERATIONS, directSeed),
        block: movingBlockBootstrapConfidenceInterval(
            directDeltasMs,
            BOOTSTRAP_ITERATIONS,
            blockSeed,
            blockLength,
        ),
        aaFloor: bcaConfidenceInterval(aaDeltasMs, BOOTSTRAP_ITERATIONS, aaSeed),
    };

    return mapMetricUnit(msMetric, toNsPerCall);
};

// Workload-level upper bound expressed as a percentage of the baseline. Only the
// bound is published, so the percent direct/block intervals exist solely to feed
// it; the paired ratio is bootstrapped directly so the baseline denominator's
// own sampling uncertainty is propagated.
const computeOverheadUpperPercent = (
    directDeltasMs: number[],
    baselineSamplesMs: number[],
    blockLength: number,
    seedFor: SeedFor,
): number => {
    const ratioEstimator = (indices: number[]) => {
        return toRatioPercent(pick(directDeltasMs, indices), pick(baselineSamplesMs, indices));
    };
    const directSeed = seedFor(':percent');
    const blockSeed = seedFor(':percent:block');
    const direct = bcaIndexConfidenceInterval(
        directDeltasMs.length,
        BOOTSTRAP_ITERATIONS,
        directSeed,
        0.95,
        ratioEstimator,
    );
    const block = movingBlockIndexBootstrapConfidenceInterval(
        directDeltasMs.length,
        BOOTSTRAP_ITERATIONS,
        blockSeed,
        blockLength,
        0.95,
        ratioEstimator,
    );

    return overheadUpperBound(direct, block);
};

const toRow = (attachment: RawBenchAttachment, result: RawWorkloadResult): BenchResultRow => {
    const baselineSamplesMs = result.variants.baseline.samplesMs;
    const directDeltasMs = getSampleDeltasMs(result.variants.instrumented, result.variants.control);
    const aaDeltasMs = getSampleDeltasMs(result.variants.control, result.variants.baseline);
    const blockLength = getBlockLength(directDeltasMs.length);
    // Every bootstrap for this row draws from a distinct but reproducible seed
    // derived from the browser/workload pair, so reruns are byte-stable.
    const seedFor: SeedFor = (suffix) => {
        return hashString(`${attachment.browserName}:${result.workloadId}${suffix}`);
    };

    const perCallNs = buildPerCallNsMetric(
        directDeltasMs,
        aaDeltasMs,
        result.instrumentedCallsPerBatch,
        blockLength,
        seedFor,
    );
    const overheadUpperPercent = computeOverheadUpperPercent(
        directDeltasMs,
        baselineSamplesMs,
        blockLength,
        seedFor,
    );
    const outlierFraction = madOutlierFraction(directDeltasMs);
    const acf1 = lag1Autocorrelation(directDeltasMs);
    // Quality is judged on the per-call ns scale, not percent: the noise it
    // tolerates (cross-bundle layout, codegen, timer granularity) is an
    // absolute per-call quantity, and percent collapses a real 3.6 ns/call
    // effect and 0.15 ns/call noise onto the same ~3.5% (see stats.ts).
    const quality = getQuality({
        direct: perCallNs.direct,
        block: perCallNs.block,
        aaFloor: perCallNs.aaFloor,
        outlierFraction,
    });

    return {
        browserName: attachment.browserName,
        workloadId: result.workloadId,
        workloadLabel: result.workloadLabel,
        batchSize: result.batchSize,
        instrumentedCallsPerBatch: result.instrumentedCallsPerBatch,
        baseline: result.variants.baseline,
        control: result.variants.control,
        instrumented: result.variants.instrumented,
        perCallNs,
        overheadUpperPercent,
        sampleCount: directDeltasMs.length,
        trimFraction: TRIM_FRACTION,
        outlierFraction,
        lag1Autocorrelation: acf1,
        quality,
    };
};

const toRows = (attachment: RawBenchAttachment): BenchResultRow[] => {
    return attachment.results.map((result) => toRow(attachment, result));
};

const formatNumber = (value: number, fractionDigits: number) => {
    return value.toLocaleString('en-US', {
        maximumFractionDigits: fractionDigits,
        minimumFractionDigits: fractionDigits,
    });
};

const formatCallOverhead = (row: BenchResultRow) => {
    return `<= ${formatNumber(row.perCallNs.upperBound, 2)} ns`;
};

const formatCallOverheadConfidenceInterval = (row: BenchResultRow) => {
    const low = formatNumber(row.perCallNs.direct.low, 2);
    const high = formatNumber(row.perCallNs.direct.high, 2);

    return `${low}..${high} ns`;
};

const formatUpperBoundPercent = (row: BenchResultRow) => {
    return `<= ${formatNumber(row.overheadUpperPercent, 2)}%`;
};

const formatNoiseFloorConfidenceInterval = (row: BenchResultRow) => {
    const low = formatNumber(row.perCallNs.aaFloor.low, 2);
    const high = formatNumber(row.perCallNs.aaFloor.high, 2);

    return `${low}..${high} ns`;
};

const formatBlockConfidenceInterval = (row: BenchResultRow) => {
    const low = formatNumber(row.perCallNs.block.low, 2);
    const high = formatNumber(row.perCallNs.block.high, 2);

    return `${low}..${high} ns`;
};

const formatSampleCount = (row: BenchResultRow) => {
    const trimPercent = row.trimFraction * 100;
    const outlierPercent = row.outlierFraction * 100;
    const formattedTrimPercent = formatNumber(trimPercent, 0);
    const formattedOutlierPercent = formatNumber(outlierPercent, 1);

    return `${row.sampleCount} (trim ${formattedTrimPercent}%, outliers ${formattedOutlierPercent}%)`;
};

const formatQuality = (row: BenchResultRow) => {
    if (row.quality.level === 'clean') {
        return 'clean';
    }

    const dominantReason = row.quality.reasons[0];

    return `${row.quality.level} (${dominantReason})`;
};

const pad = (value: string, width: number) => {
    return value.padEnd(width, ' ');
};

const padLeft = (value: string, width: number) => {
    return value.padStart(width, ' ');
};

export const buildAlignedTable = (rows: BenchResultRow[]) => {
    const headers = [
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
    ];
    const rightAlignedColumns = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const body = rows.map((row) => [
        row.browserName,
        row.workloadLabel,
        formatQuality(row),
        formatCallOverhead(row),
        formatUpperBoundPercent(row),
        formatCallOverheadConfidenceInterval(row),
        formatNoiseFloorConfidenceInterval(row),
        formatBlockConfidenceInterval(row),
        formatNumber(row.lag1Autocorrelation, 2),
        `${formatNumber(row.baseline.medianMs, 3)} ms`,
        `${formatNumber(row.instrumented.medianMs, 3)} ms`,
        formatSampleCount(row),
    ]);
    const widths = headers.map((header, index) => {
        const bodyWidths = body.map((row) => row[index].length);
        return Math.max(header.length, ...bodyWidths);
    });
    const formatLine = (cells: string[]) => {
        return cells
            .map((value, index) =>
                rightAlignedColumns.has(index)
                    ? padLeft(value, widths[index])
                    : pad(value, widths[index]),
            )
            .join('  ');
    };
    const separator = widths.map((width) => ''.padEnd(width, '-')).join('  ');
    const lines = [formatLine(headers), separator, ...body.map(formatLine)];

    return lines.join('\n');
};

// Normalize an HTTP ETag header value to its bare content hash: strip the optional weak
// validator prefix (W/) and the surrounding quotes. CloudFront returns a weak ETag (W/"...")
// when it compresses the response, so the raw header varies in shape for identical content.
export const normalizeEtag = (etag: string): string => etag.replace(/^W\//, '').replace(/"/g, '');

// Build the "Browser Debugger SDK" label: the baked version plus the CDN build fingerprint
// (publish date and short S3 ETag). The ETag is explicitly labeled so it is not mistaken for
// a git commit SHA. `code` wraps the version/etag in markdown backticks when rendering a comment.
const formatSdkLabel = (
    sdkVersion: string,
    sdkBuild: SdkBuild | undefined,
    code: (value: string) => string = (value) => value,
): string => {
    const parts = [code(sdkVersion)];
    if (sdkBuild) {
        parts.push(`built ${sdkBuild.publishedAt.slice(0, 10)}`);
        const shortEtag = normalizeEtag(sdkBuild.etag).slice(0, 8);
        parts.push(`S3 ETag ${code(shortEtag)}`);
    }
    return parts.join(' · ');
};

const printRows = (rows: BenchResultRow[], sdkVersion?: string, sdkBuild?: SdkBuild) => {
    if (rows.length === 0) {
        console.log('\nLive Debugger runtime benchmark produced no results.');
        return;
    }

    console.log('\nLive Debugger runtime benchmark');
    if (sdkVersion) {
        console.log(`Browser Debugger SDK: ${formatSdkLabel(sdkVersion, sdkBuild)}`);
    }
    console.log(buildAlignedTable(rows));
};

const printFailures = (failures: BenchFailure[]) => {
    if (failures.length === 0) {
        return;
    }

    console.log('\nLive Debugger runtime benchmark failures');
    for (const failure of failures) {
        console.log(`- [${failure.projectName}] ${failure.title}: ${failure.error}`);
    }
};

const printOutputPaths = (resultsFile: string) => {
    console.log(`\nRaw results written to ${resultsFile}`);
};

export const renderMarkdownComment = (
    rows: BenchResultRow[],
    failures: BenchFailure[],
    sdkVersion?: string,
    sdkBuild?: SdkBuild,
) => {
    let body = `${COMMENT_MARKER}\n## Live Debugger Runtime Benchmark\n\n`;

    if (rows.length === 0) {
        body += 'Benchmark results were not produced. Check the workflow logs for details.\n';
    } else {
        body +=
            'SDK-loaded dormant-probe runtime overhead, measured against an uninstrumented bundle in the same browser session.\n\n';
        if (sdkVersion) {
            const sdkLabel = formatSdkLabel(sdkVersion, sdkBuild, (value) => `\`${value}\``);
            body += `Browser Debugger SDK: ${sdkLabel}\n\n`;
        }
        body += '| Browser | Workload | Quality | Per-call overhead upper |\n';
        body += '| --- | --- | --- | ---: |\n';

        for (const row of rows) {
            body += `| ${row.browserName} | ${row.workloadLabel} | ${formatQuality(row)} | ${formatCallOverhead(row)} |\n`;
        }

        body += '\n<details>\n<summary>Full diagnostics</summary>\n\n';
        body += '```\n';
        body += `${buildAlignedTable(rows)}\n`;
        body += '```\n';
        body += '\n</details>\n';
    }

    if (failures.length > 0) {
        body += '\n### Benchmark failures\n\n';
        for (const failure of failures) {
            body += `- **${failure.projectName}** (${failure.status}): ${failure.error}\n`;
        }
    }

    if (rows.length > 0 || failures.length > 0) {
        body += '\nRaw samples are in the `live-debugger-runtime-bench-results` artifact.\n';
    }

    return body;
};

export default class BenchReporter implements Reporter {
    private rows: BenchResultRow[] = [];
    private failures: BenchFailure[] = [];
    private sdkVersion: string | undefined;
    private sdkBuild: SdkBuild | undefined;

    onTestEnd(test: TestCase, result: TestResult) {
        if (result.status !== 'passed') {
            const errorMessage = result.error?.message || result.error?.value || result.status;
            this.failures.push({
                projectName: test.parent.project()?.name || 'unknown',
                title: test.title,
                status: result.status,
                error: errorMessage,
            });
            return;
        }

        const attachments = parseAttachmentBody(result);
        for (const attachment of attachments) {
            this.sdkVersion = attachment.sdkVersion;
            this.sdkBuild = attachment.sdkBuild;
            this.rows.push(...toRows(attachment));
        }
    }

    onEnd(result: FullResult) {
        this.rows.sort((a, b) => {
            const aKey = `${a.browserName} | ${a.workloadId}`;
            const bKey = `${b.browserName} | ${b.workloadId}`;

            return aKey.localeCompare(bKey);
        });

        printRows(this.rows, this.sdkVersion, this.sdkBuild);
        printFailures(this.failures);
        const markdownComment = renderMarkdownComment(
            this.rows,
            this.failures,
            this.sdkVersion,
            this.sdkBuild,
        );
        outputFileSync(COMMENT_FILE, markdownComment);
        const generatedAt = new Date().toISOString();
        const resultsFile = buildResultsFilePath(generatedAt);
        outputFileSync(
            resultsFile,
            `${JSON.stringify(
                {
                    status: result.status,
                    generatedAt,
                    sdkVersion: this.sdkVersion,
                    sdkBuild: this.sdkBuild,
                    rows: this.rows,
                    failures: this.failures,
                },
                null,
                2,
            )}\n`,
        );
        printOutputPaths(resultsFile);
    }
}
