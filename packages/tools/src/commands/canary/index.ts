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
import { checkoutTarget, getCheckoutRef, resolveExistingCheckout } from './checkout';
import { NETWORK_RETRY_DELAYS_MS, runCanary, StreamingCommandRunner } from './runner';
import {
    DEFAULT_RUNTIME_CPU_THROTTLING,
    DEFAULT_RUNTIME_LCP_SETTLE_MS,
    DEFAULT_RUNTIME_MAX_WAIT_MS,
    DEFAULT_RUNTIME_NETWORK,
    DEFAULT_RUNTIME_REPETITIONS,
    parseRuntimeSettings,
} from './runtime-options';
import type { RuntimeComparison } from './runtime';
import { CHROME_PATH_ENV, findChrome } from './runtime';
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
    RuntimeOptions,
    RuntimeReport,
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

const formatRoundedMs = (value: number): string => {
    return `${Math.round(value)} ms`;
};

const formatPercentage = (value: number): string => {
    return `${value.toFixed(1)}%`;
};

const formatSigned = (value: number, formatter: (value: number) => string): string => {
    const sign = value > 0 ? '+' : value < 0 ? '-' : '';
    const magnitude = Math.abs(value);
    return `${sign}${formatter(magnitude)}`;
};

export const formatRuntimeComparison = (
    comparison: RuntimeComparison | null,
    formatter: (value: number) => string,
): string => {
    if (!comparison) {
        return 'n/a';
    }
    const control = formatter(comparison.control);
    const instrumented = formatter(comparison.instrumented);
    const delta = formatSigned(comparison.delta, formatter);
    const percentage =
        comparison.deltaPercent === null
            ? 'n/a'
            : formatSigned(comparison.deltaPercent, formatPercentage);
    let interval = '';
    if (comparison.deltaCi95Low !== null && comparison.deltaCi95High !== null) {
        const low = formatSigned(comparison.deltaCi95Low, formatter);
        const high = formatSigned(comparison.deltaCi95High, formatter);
        interval = `, 95% CI ${low} to ${high}`;
    }
    return `${control} -> ${instrumented} (${delta}, ${percentage}${interval})`;
};

const RUNTIME_LINES = [
    { label: 'FCP:        ', metric: 'fcpMs', formatter: formatRoundedMs },
    { label: 'LCP:        ', metric: 'lcpMs', formatter: formatRoundedMs },
    { label: 'script:     ', metric: 'scriptMs', formatter: formatRoundedMs },
    { label: 'blocking:   ', metric: 'blockingBeforeLcpMs', formatter: formatRoundedMs },
    { label: 'JS decoded: ', metric: 'jsDecodedBytes', formatter: formatBytes },
] as const;

const printRuntimeReport = (runtime: RuntimeReport): void => {
    for (const phase of runtime.phases) {
        console.log(`\n${phase.phase} in ${phase.browser.version}: control -> variant medians`);
        for (const condition of phase.conditions) {
            console.log(
                `  ${condition.page}, ${condition.cache} cache, CPU ${condition.cpuThrottling}x`,
            );
            for (const comparison of condition.comparisons) {
                console.log(`    ${comparison.variant}`);
                for (const { formatter, label, metric } of RUNTIME_LINES) {
                    const metricComparison = comparison.metrics[metric];
                    const formatted = formatRuntimeComparison(metricComparison, formatter);
                    console.log(`      ${label}${formatted}`);
                }
            }
        }
    }
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
    if (report.runtime) {
        printRuntimeReport(report.runtime);
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
            ['Also compare page loads in headless Chrome', '$0 canary <target> --runtime'],
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

    runtime = Option.Boolean('--runtime', false, {
        description:
            'Also load each build in headless Chrome and compare page-load metrics, for targets with a runtime spec.',
    });

    runtimeChrome = Option.String('--runtime-chrome', {
        description: `Chrome or Chromium executable. Defaults to ${CHROME_PATH_ENV}, then the first google-chrome, chromium or chrome on PATH.`,
    });

    runtimeRepetitions = Option.String('--runtime-repetitions', DEFAULT_RUNTIME_REPETITIONS, {
        description: 'Loads of each variant per page, cache state and CPU rate. At least 3.',
    });

    runtimeCpuThrottling = Option.String(
        '--runtime-cpu-throttling',
        DEFAULT_RUNTIME_CPU_THROTTLING,
        {
            description:
                'Comma-separated CPU slowdown factors, each its own condition, 1 for none.',
        },
    );

    runtimeNetwork = Option.String('--runtime-network', DEFAULT_RUNTIME_NETWORK, {
        description: 'Network throttling, "<download Mbps>:<upload Mbps>:<latency ms>" or "none".',
    });

    runtimeLcpSettleMs = Option.String('--runtime-lcp-settle-ms', DEFAULT_RUNTIME_LCP_SETTLE_MS, {
        description: 'A load ends once no new LCP candidate has appeared for this long.',
    });

    runtimeMaxWaitMs = Option.String('--runtime-max-wait-ms', DEFAULT_RUNTIME_MAX_WAIT_MS, {
        description: 'A load ends this long after navigation started at the latest.',
    });

    private async getRuntimeOptions(): Promise<RuntimeOptions | undefined> {
        if (!this.runtime) {
            return undefined;
        }
        try {
            const settings = parseRuntimeSettings({
                cpuThrottling: this.runtimeCpuThrottling,
                lcpSettleMs: this.runtimeLcpSettleMs,
                maxWaitMs: this.runtimeMaxWaitMs,
                network: this.runtimeNetwork,
                repetitions: this.runtimeRepetitions,
            });
            const chromePath = await findChrome({
                env: process.env,
                explicitPath: this.runtimeChrome,
            });
            return { chromePath, settings };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UsageError(message);
        }
    }

    async execute(): Promise<number> {
        const target = getTargetOrThrow(this.targetName);
        const runtime = await this.getRuntimeOptions();
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
        const abortController = new AbortController();
        const handleSignal = (signal: InterruptSignal): void => {
            interruption = signal;
            commandRunner.cancel(signal);
            abortController.abort(signal);
        };
        const handleInterrupt = (): void => handleSignal('SIGINT');
        const handleTermination = (): void => handleSignal('SIGTERM');
        process.once('SIGINT', handleInterrupt);
        process.once('SIGTERM', handleTermination);

        try {
            const report = await runCanary({
                abortSignal: abortController.signal,
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
                runtime,
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

            With --existing, uses the checkout already in --root instead of fetching one,
            for example one a CI job fetched itself, and only resolves its commit and
            toolchain.

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
            [
                'Resolve the toolchain of a checkout that already exists',
                '$0 canary-checkout <target> --root <checkout> --existing --artifacts-dir <dir>',
            ],
        ],
    });

    targetName = Option.String();

    root = Option.String('--root', {
        description:
            'Directory to create the checkout in. It must be missing or empty, unless --existing is set.',
        required: true,
    });

    existing = Option.Boolean('--existing', false, {
        description: 'Use the checkout already in --root instead of fetching one.',
    });

    ref = Option.String('--ref', {
        description: "Branch or full commit SHA to use instead of the target's branch or pin.",
    });

    artifactsDirectory = Option.String('--artifacts-dir', {
        description: `Directory for ${TOOLCHAIN_FILE}, a log file per command in logs/checkout/, and ${ALERT_FILE} when it fails.`,
    });

    async execute(): Promise<number> {
        const target = getTargetOrThrow(this.targetName);
        if (this.existing && this.ref) {
            throw new UsageError('--ref and --existing cannot be combined.');
        }
        const root = path.resolve(this.root);
        const ref = this.existing ? 'HEAD' : getCheckoutRef(target.repository, this.ref);
        const pin = target.repository.pin;
        if (pin && !this.ref && !this.existing) {
            this.context.stdout.write(
                `[Canary] ${target.id} is pinned to ${pin.commit}: ${pin.reason}\n`,
            );
        }

        const logDirectory = getLogDirectory(this.artifactsDirectory, 'checkout');
        const commandRunner = new StreamingCommandRunner(logDirectory);
        const distUrl = process.env.CANARY_NODE_DIST_URL ?? DEFAULT_NODE_DIST_URL;

        try {
            const commit = this.existing
                ? await resolveExistingCheckout({ root, runCommand: commandRunner.run })
                : await checkoutTarget({
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
            const checkoutMessage = this.existing
                ? `Using the existing ${target.repository.name} checkout at ${commit}.`
                : `Checked out ${target.repository.name} ${ref} at ${commit}.`;
            this.context.stdout.write(`\n[Canary] ${checkoutMessage}\n`);
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
