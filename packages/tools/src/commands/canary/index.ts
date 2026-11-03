// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile } from '@dd/core/helpers/fs';
import { formatDuration as formatMilliseconds } from '@dd/core/helpers/strings';
import { ROOT } from '@dd/tools/constants';
import { Command, Option, UsageError } from 'clipanion';
import os from 'os';
import path from 'path';

import { formatCheckoutAlert } from './alert';
import { checkoutTarget, getCheckoutRef } from './checkout';
import { NETWORK_RETRY_DELAYS_MS, runCanary, StreamingCommandRunner } from './runner';
import { getCanaryTarget, getCanaryTargetNames } from './targets';
import {
    DEFAULT_NODE_DIST_URL,
    fetchNodeReleases,
    formatToolchainEnvironment,
    resolveToolchain,
} from './toolchain';
import { INSTRUMENTED_VARIANTS } from './types';
import type {
    AlertOptions,
    CanaryReport,
    CanaryTarget,
    InterruptSignal,
    MetricComparison,
} from './types';

const SUPPORTED_TARGETS = getCanaryTargetNames().join(', ');
const REPORT_FILE = 'report.json';
const LOGS_DIRECTORY = 'logs';
const TOOLCHAIN_FILE = 'toolchain.env';
const ALERT_FILE = 'slack-message.txt';

const getTargetOrThrow = (name: string): CanaryTarget => {
    const target = getCanaryTarget(name);
    if (!target) {
        throw new UsageError(
            `Unknown canary target "${name}". Available targets: ${SUPPORTED_TARGETS}.`,
        );
    }
    return target;
};

// Each command logs to its own subdirectory, since both number their commands from 01.
const getLogDirectory = (
    artifactsDirectory: string | undefined,
    command: 'canary' | 'checkout',
): string | undefined => {
    return artifactsDirectory
        ? path.resolve(artifactsDirectory, LOGS_DIRECTORY, command)
        : undefined;
};

// GitLab sets these in every job, so alerts can link back to the run.
const getAlertLinks = (): AlertOptions['links'] => {
    return {
        job: process.env.CI_JOB_URL,
        pipeline: process.env.CI_PIPELINE_URL,
    };
};

const getAlertPath = (artifactsDirectory: string | undefined): string | undefined => {
    return artifactsDirectory ? path.resolve(artifactsDirectory, ALERT_FILE) : undefined;
};

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
        for (const variant of INSTRUMENTED_VARIANTS) {
            const comparison = phase.comparisons[variant];
            console.log(`  ${variant}`);
            console.log(`    build time: ${formatDelta(comparison.durationMs, formatDuration)}`);
            console.log(`    raw JS:     ${formatDelta(comparison.rawBytes, formatBytes)}`);
            console.log(`    gzip JS:    ${formatDelta(comparison.gzipBytes, formatBytes)}`);
        }
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
            [
                'Run in CI on a fresh checkout from canary-checkout',
                '$0 canary <target> --root <checkout> --install --no-cleanup --artifacts-dir <dir>',
            ],
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

    install = Option.Boolean('--install', false, {
        description: "Install the target's dependencies first, retrying network failures.",
    });

    cleanup = Option.Boolean('--cleanup', true, {
        description:
            "Revert the target checkout's changes afterwards. Pass --no-cleanup on disposable checkouts.",
    });

    artifactsDirectory = Option.String('--artifacts-dir', {
        description: `Directory for ${REPORT_FILE} (unless --report is set), a log file per command in logs/canary/, and ${ALERT_FILE} when the run fails.`,
    });

    async execute(): Promise<number> {
        const target = getTargetOrThrow(this.targetName);
        const root = path.resolve(this.root ?? target.getDefaultRoot());
        const artifactsReportPath = this.artifactsDirectory
            ? path.resolve(this.artifactsDirectory, REPORT_FILE)
            : undefined;
        const reportPath = this.report
            ? path.resolve(this.report)
            : artifactsReportPath ?? getDefaultReportPath();
        const runId = getRunId();
        const logDirectory = getLogDirectory(this.artifactsDirectory, 'canary');
        const commandRunner = new StreamingCommandRunner(logDirectory);
        const alertPath = getAlertPath(this.artifactsDirectory);
        const alertLinks = getAlertLinks();
        const alert = alertPath ? { path: alertPath, links: alertLinks } : undefined;
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
                alert,
                buildPluginsRoot: ROOT,
                cleanup: this.cleanup,
                install: this.install,
                networkRetryDelaysMs: NETWORK_RETRY_DELAYS_MS,
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

class CanaryCheckout extends Command {
    static paths = [['canary-checkout']];

    static usage = Command.Usage({
        category: 'Verification',
        description: "Fetch a canary target's checkout and resolve its toolchain.",
        details: `
            Fetches one commit of the target's repository into an empty directory: the tip
            of its tracked branch, its temporary pin, or --ref. Set GH_TOKEN to read private
            repositories.

            Then resolves the Node.js version and package manager the checkout declares,
            prints them, and writes them to ${TOOLCHAIN_FILE} in --artifacts-dir.

            Registered targets: ${SUPPORTED_TARGETS}.
        `,
        examples: [
            [
                "Check out a target's tracked branch",
                '$0 canary-checkout <target> --root <checkout> --artifacts-dir <dir>',
            ],
            [
                'Check out a specific commit',
                '$0 canary-checkout <target> --root <checkout> --ref <sha>',
            ],
        ],
    });

    targetName = Option.String();

    root = Option.String('--root', {
        description: 'Directory to create the checkout in. It must be missing or empty.',
        required: true,
    });

    ref = Option.String('--ref', {
        description: "Branch or full commit SHA to use instead of the target's branch or pin.",
    });

    artifactsDirectory = Option.String('--artifacts-dir', {
        description: `Directory for ${TOOLCHAIN_FILE}, a log file per command in logs/checkout/, and ${ALERT_FILE} when it fails.`,
    });

    async execute(): Promise<number> {
        const target = getTargetOrThrow(this.targetName);
        const root = path.resolve(this.root);
        const ref = getCheckoutRef(target.repository, this.ref);
        const pin = target.repository.pin;
        if (pin && !this.ref) {
            this.context.stdout.write(
                `[Canary] ${target.id} is pinned to ${pin.commit}: ${pin.reason}\n`,
            );
        }

        const logDirectory = getLogDirectory(this.artifactsDirectory, 'checkout');
        const commandRunner = new StreamingCommandRunner(logDirectory);
        const distUrl = process.env.CANARY_NODE_DIST_URL ?? DEFAULT_NODE_DIST_URL;

        try {
            const commit = await checkoutTarget({
                networkRetryDelaysMs: NETWORK_RETRY_DELAYS_MS,
                ref,
                repository: target.repository,
                root,
                runCommand: commandRunner.run,
                token: process.env.GH_TOKEN,
            });
            const toolchain = await resolveToolchain({
                getNodeReleases: () => fetchNodeReleases(distUrl),
                root,
                target,
            });
            const environment = formatToolchainEnvironment(toolchain, commit);
            this.context.stdout.write(
                `\n[Canary] Checked out ${target.repository.name} ${ref} at ${commit}.\n`,
            );
            this.context.stdout.write(
                `[Canary] Node.js ${toolchain.node.version} comes from ${toolchain.node.source}.\n`,
            );
            this.context.stdout.write(environment);

            if (this.artifactsDirectory) {
                const toolchainPath = path.resolve(this.artifactsDirectory, TOOLCHAIN_FILE);
                await outputFile(toolchainPath, environment);
            }
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.context.stderr.write(`\n[Canary] ${message}\n`);
            const alertPath = getAlertPath(this.artifactsDirectory);
            if (alertPath) {
                const links = getAlertLinks();
                const alert = formatCheckoutAlert({
                    links,
                    message,
                    ref,
                    repository: target.repository.name,
                    target: target.id,
                });
                await outputFile(alertPath, alert);
            }
            return 1;
        }
    }
}

export default [Canary, CanaryCheckout];
