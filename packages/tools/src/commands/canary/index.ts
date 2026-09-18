// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration as formatMilliseconds } from '@dd/core/helpers/strings';
import { ROOT } from '@dd/tools/constants';
import { Command, Option, UsageError } from 'clipanion';
import os from 'os';
import path from 'path';

import { runCanary, StreamingCommandRunner } from './runner';
import { getCanaryTarget, getCanaryTargetNames } from './targets';
import type { CanaryReport, InterruptSignal, MetricComparison } from './types';

const SUPPORTED_TARGETS = getCanaryTargetNames().join(', ');

const getRunId = (): string => {
    return process.env.CI_PIPELINE_ID ?? process.env.GITHUB_RUN_ID ?? new Date().toISOString();
};

const getDefaultReportPath = (): string => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.resolve(os.tmpdir(), `build-plugins-canary-${timestamp}.json`);
};

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;
const BYTES_PER_UNIT = 1_000;

const formatDuration = (durationMs: number): string => {
    const roundedDurationMs = Math.round(durationMs / 1_000) * 1_000;
    return roundedDurationMs === 0 ? '0s' : formatMilliseconds(roundedDurationMs);
};

export const formatBytes = (bytes: number): string => {
    let value = bytes;
    let unitIndex = 0;

    while (Math.abs(value) >= BYTES_PER_UNIT && unitIndex < BYTE_UNITS.length - 1) {
        value /= BYTES_PER_UNIT;
        unitIndex++;
    }

    const maximumFractionDigits = unitIndex === 0 ? 0 : 2;
    const formatted = value.toLocaleString('en-US', { maximumFractionDigits });
    return `${formatted} ${BYTE_UNITS[unitIndex]}`;
};

export const formatDelta = (
    comparison: MetricComparison,
    formatter: (value: number) => string,
): string => {
    const sign = comparison.delta > 0 ? '+' : comparison.delta < 0 ? '-' : '';
    const absoluteDelta = Math.abs(comparison.delta);
    const percentage =
        comparison.deltaPercent === null
            ? 'n/a'
            : `${sign}${Math.abs(comparison.deltaPercent).toFixed(2)}%`;
    return `${formatter(comparison.control)} -> ${formatter(
        comparison.instrumented,
    )} (${sign}${formatter(absoluteDelta)}, ${percentage})`;
};

const printReport = (report: CanaryReport): void => {
    console.log('\n[Canary] Live Debugger comparison');
    for (const phase of report.phases) {
        console.log(`\n${phase.id} (${phase.buildTool})`);
        console.log(`  build time: ${formatDelta(phase.comparison.durationMs, formatDuration)}`);
        console.log(`  raw JS:     ${formatDelta(phase.comparison.rawBytes, formatBytes)}`);
        console.log(`  gzip JS:    ${formatDelta(phase.comparison.gzipBytes, formatBytes)}`);
    }
    console.log(`\n[Canary] JSON report: ${report.reportPath}`);
};

class Canary extends Command {
    static paths = [['canary']];

    static usage = Command.Usage({
        category: 'Verification',
        description: 'Run an external-project canary with control and Live Debugger builds.',
        details: `Registered targets: ${SUPPORTED_TARGETS}.`,
        examples: [
            ['Run every phase for a target', '$0 canary <target>'],
            ['Run one target-defined phase', '$0 canary <target> --phase <phase>'],
        ],
    });

    targetName = Option.String();

    root = Option.String('--root', {
        description: 'Path to the target repository checkout.',
    });

    phase = Option.String('--phase', 'all', {
        description: 'Target phase to run, or "all".',
    });

    report = Option.String('--report', {
        description: 'Path for the versioned JSON result.',
    });

    async execute(): Promise<number> {
        const target = getCanaryTarget(this.targetName);
        if (!target) {
            const targetNames = getCanaryTargetNames().join(', ');
            throw new UsageError(
                `Unknown canary target "${this.targetName}". Available targets: ${targetNames}.`,
            );
        }

        const root = path.resolve(this.root ?? target.getDefaultRoot());
        const reportPath = this.report ? path.resolve(this.report) : getDefaultReportPath();
        const runId = getRunId();
        const commandRunner = new StreamingCommandRunner();
        let interruption: InterruptSignal | undefined;
        const handleSignal = (signal: InterruptSignal): void => {
            interruption = signal;
            commandRunner.cancel(signal);
        };
        const handleInterrupt = (): void => handleSignal('SIGINT');
        const handleTermination = (): void => handleSignal('SIGTERM');
        process.once('SIGINT', handleInterrupt);
        process.once('SIGTERM', handleTermination);

        try {
            const report = await runCanary({
                buildPluginsRoot: ROOT,
                phaseSelection: this.phase,
                reportPath,
                root,
                runCommand: commandRunner.run,
                runId,
                target,
            });
            printReport(report);
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.context.stderr.write(`\n[Canary] ${message}\n`);
            this.context.stderr.write(`[Canary] JSON report: ${reportPath}\n`);
            if (interruption === 'SIGINT') {
                return 130;
            }
            if (interruption === 'SIGTERM') {
                return 143;
            }
            return 1;
        } finally {
            process.removeListener('SIGINT', handleInterrupt);
            process.removeListener('SIGTERM', handleTermination);
        }
    }
}

export default [Canary];
