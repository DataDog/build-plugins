// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, readFile } from '@dd/core/helpers/fs';
import { execute, slugify } from '@dd/tools/helpers';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { glob } from 'glob';
import path from 'path';
import { performance } from 'perf_hooks';
import type { Readable, Writable } from 'stream';
import { gzipSync } from 'zlib';

import { CANARY_VARIANTS } from './types';
import type {
    ArtifactMeasurement,
    ArtifactSpec,
    CanaryFailure,
    CanaryPhase,
    CanaryReport,
    CanaryTarget,
    CanaryVariant,
    Cleanup,
    CommandResult,
    CommandSpec,
    InterruptSignal,
    MetricComparison,
    PhaseComparison,
    PhaseReport,
    RunCommand,
    VariantMeasurement,
    VariantReport,
} from './types';

const normalizeError = (error: unknown): Error => {
    return error instanceof Error ? error : new Error(String(error));
};

export class CanaryCommandError extends Error {}

// Thrown for commands that are cut short or refused after an interrupt, so retries stop.
export class CanaryInterruptedError extends Error {}

// Network-bound steps (fetching the target, installing its dependencies) are retried
// after these delays. Builds and validations are never retried.
export const NETWORK_RETRY_DELAYS_MS = [10_000, 30_000];

const wait = (durationMs: number): Promise<void> => {
    return new Promise((resolve) => {
        setTimeout(resolve, durationMs);
    });
};

export const withRetries = async <T>(task: () => Promise<T>, delaysMs: number[]): Promise<T> => {
    for (const delayMs of delaysMs) {
        try {
            return await task();
        } catch (error) {
            if (error instanceof CanaryInterruptedError) {
                throw error;
            }
            const normalized = normalizeError(error);
            console.log(`\n[Canary] ${normalized.message} Retrying in ${delayMs / 1_000}s.`);
            await wait(delayMs);
        }
    }
    return task();
};

const formatCommandLog = (spec: CommandSpec, output: string, outcome: string): string => {
    const commandLine = [spec.command, ...spec.args].join(' ');
    return `$ ${commandLine}\n# cwd: ${spec.cwd}\n\n${output}\n# ${outcome}\n`;
};

export class StreamingCommandRunner {
    private activeChild: ChildProcess | undefined;
    private interruption: InterruptSignal | undefined;
    private commandCount = 0;
    // When set, each command's output is also written to its own numbered log file.
    private readonly logDirectory: string | undefined;

    constructor(logDirectory?: string) {
        this.logDirectory = logDirectory;
    }

    cancel(signal: InterruptSignal): void {
        this.interruption = signal;
        this.activeChild?.kill(signal);
    }

    private async writeLog(
        sequence: number,
        spec: CommandSpec,
        output: string,
        outcome: string,
    ): Promise<void> {
        if (!this.logDirectory) {
            return;
        }
        const prefix = String(sequence).padStart(2, '0');
        // Keep repository names like owner/name readable in the file name.
        const label = spec.label.replace(/\//g, ' ');
        const fileName = `${prefix}-${slugify(label)}.log`;
        const logPath = path.resolve(this.logDirectory, fileName);
        const log = formatCommandLog(spec, output, outcome);
        await outputFile(logPath, log);
    }

    run: RunCommand = async (spec) => {
        if (this.interruption) {
            throw new CanaryInterruptedError(
                `${spec.label} was not started after ${this.interruption}.`,
            );
        }

        this.commandCount += 1;
        const sequence = this.commandCount;
        const startedAt = performance.now();
        const env = {
            ...process.env,
            ...spec.env,
        };

        return new Promise<CommandResult>((resolve, reject) => {
            const child = spawn(spec.command, spec.args, {
                cwd: spec.cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.activeChild = child;

            let output = '';
            let settled = false;

            const capture = (stream: Readable, destination: Writable): void => {
                stream.setEncoding('utf8');
                stream.on('data', (chunk: string) => {
                    output += chunk;
                    destination.write(chunk);
                });
            };

            capture(child.stdout, process.stdout);
            capture(child.stderr, process.stderr);

            child.once('error', (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.activeChild = undefined;
                const logWritten = this.writeLog(sequence, spec, output, `error: ${error.message}`);
                logWritten.then(() => reject(error), reject);
            });

            child.once('close', (exitCode, signal) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.activeChild = undefined;
                const outcome = signal ? `signal ${signal}` : `exit code ${exitCode}`;
                const logWritten = this.writeLog(sequence, spec, output, outcome);
                logWritten.then(() => {
                    if (this.interruption) {
                        const interrupted = new CanaryInterruptedError(
                            `${spec.label} was interrupted by ${this.interruption}.`,
                        );
                        reject(interrupted);
                        return;
                    }
                    resolve({
                        durationMs: performance.now() - startedAt,
                        exitCode,
                        output,
                        signal,
                    });
                }, reject);
            });
        });
    };
}

export const runCheckedCommand = async (
    runCommand: RunCommand,
    spec: CommandSpec,
): Promise<CommandResult> => {
    const result = await runCommand(spec);
    if (result.exitCode === 0) {
        return result;
    }

    const exitDescription = result.signal
        ? `signal ${result.signal}`
        : `exit code ${result.exitCode ?? 'unknown'}`;
    throw new CanaryCommandError(`${spec.label} failed with ${exitDescription}.`);
};

const getArtifactFiles = async (spec: ArtifactSpec): Promise<string[]> => {
    const filePaths = new Set<string>();

    for (const root of spec.roots) {
        for (const pattern of spec.patterns) {
            const matches = await glob(pattern, {
                absolute: true,
                cwd: root,
                nodir: true,
            });
            for (const match of matches) {
                filePaths.add(match);
            }
        }
    }

    return Array.from(filePaths).sort();
};

export const measureArtifacts = async (
    spec: ArtifactSpec,
): Promise<ArtifactMeasurement & { filePaths: string[] }> => {
    const filePaths = await getArtifactFiles(spec);
    let gzipBytes = 0;
    let rawBytes = 0;

    for (const filePath of filePaths) {
        const content = await readFile(filePath);
        rawBytes += Buffer.byteLength(content);
        const compressed = gzipSync(content);
        gzipBytes += compressed.length;
    }

    return {
        fileCount: filePaths.length,
        filePaths,
        gzipBytes,
        rawBytes,
    };
};

export const createMetricComparison = (control: number, instrumented: number): MetricComparison => {
    const delta = instrumented - control;
    const deltaPercent = control === 0 ? null : (delta / control) * 100;

    return {
        control,
        instrumented,
        delta,
        deltaPercent,
    };
};

const createPhaseComparison = (
    control: VariantMeasurement,
    instrumented: VariantMeasurement,
): PhaseComparison => {
    return {
        durationMs: createMetricComparison(control.durationMs, instrumented.durationMs),
        gzipBytes: createMetricComparison(control.gzipBytes, instrumented.gzipBytes),
        rawBytes: createMetricComparison(control.rawBytes, instrumented.rawBytes),
    };
};

const hash = (value: string): number => {
    let result = 0;
    for (const character of value) {
        result = (result * 31 + character.charCodeAt(0)) % Number.MAX_SAFE_INTEGER;
    }
    return result;
};

const getPermutations = <T>(values: readonly T[]): T[][] => {
    if (values.length <= 1) {
        return [[...values]];
    }

    return values.flatMap((value, index) => {
        const remaining = values.filter((_, remainingIndex) => remainingIndex !== index);
        const permutations = getPermutations(remaining);
        return permutations.map((permutation) => [value, ...permutation]);
    });
};

// Every permutation is equally likely, so each pair of variants runs in
// either order equally often across runs.
const VARIANT_ORDERS = getPermutations(CANARY_VARIANTS);

export const getVariantOrder = (runId: string, phaseId: string): CanaryVariant[] => {
    const key = `${runId}:${phaseId}`;
    const index = hash(key) % VARIANT_ORDERS.length;
    return VARIANT_ORDERS[index] ?? [...CANARY_VARIANTS];
};

const measureVariant = async ({
    phase,
    root,
    runCommand,
    variant,
}: {
    phase: CanaryPhase;
    root: string;
    runCommand: RunCommand;
    variant: CanaryVariant;
}): Promise<VariantReport> => {
    const buildCommand = phase.getBuildCommand(root, variant);
    const buildResult = await runCheckedCommand(runCommand, buildCommand);
    phase.assertBuildOutput(buildResult, variant);

    const artifactSpec = phase.getArtifactSpec(root, variant);
    const artifacts = await measureArtifacts(artifactSpec);
    if (artifacts.fileCount === 0) {
        throw new CanaryCommandError(
            `${phase.id} ${variant} build emitted no matching JavaScript files.`,
        );
    }
    if (phase.assertArtifacts) {
        await phase.assertArtifacts(artifacts.filePaths, variant);
    }

    if (phase.getValidationCommand) {
        const validationCommand = phase.getValidationCommand(root, variant);
        await runCheckedCommand(runCommand, validationCommand);
    }

    return {
        durationMs: buildResult.durationMs,
        fileCount: artifacts.fileCount,
        gzipBytes: artifacts.gzipBytes,
        rawBytes: artifacts.rawBytes,
        outputRoots: artifactSpec.roots,
    };
};

const runPhase = async ({
    phase,
    root,
    runCommand,
    runId,
}: {
    phase: CanaryPhase;
    root: string;
    runCommand: RunCommand;
    runId: string;
}): Promise<PhaseReport> => {
    const variantOrder = getVariantOrder(runId, phase.id);
    const results: Partial<Record<CanaryVariant, VariantReport>> = {};

    for (const variant of variantOrder) {
        console.log(`\n[Canary] Running ${phase.id} ${variant} build.`);
        results[variant] = await measureVariant({
            phase,
            root,
            runCommand,
            variant,
        });
    }

    const control = results.control;
    const allFunctions = results['all-functions'];
    const namedOnly = results['named-only'];
    if (!control || !allFunctions || !namedOnly) {
        throw new CanaryCommandError(`${phase.id} did not produce every canary variant.`);
    }

    return {
        id: phase.id,
        buildTool: phase.buildTool,
        localPackages: phase.localPackages,
        variantOrder,
        variants: {
            control,
            'all-functions': allFunctions,
            'named-only': namedOnly,
        },
        comparisons: {
            'all-functions': createPhaseComparison(control, allFunctions),
            'named-only': createPhaseComparison(control, namedOnly),
        },
    };
};

const getGitState = async (root: string): Promise<{ commit: string; dirty: boolean }> => {
    try {
        const commitResult = await execute('git', ['rev-parse', 'HEAD'], root);
        const statusResult = await execute(
            'git',
            ['status', '--porcelain', '--untracked-files=normal'],
            root,
        );
        return {
            commit: commitResult.stdout.trim(),
            dirty: statusResult.stdout.trim().length > 0,
        };
    } catch {
        return {
            commit: 'unknown',
            dirty: true,
        };
    }
};

const runCleanups = async (
    cleanups: Cleanup[],
    failures: CanaryFailure[],
): Promise<Error | undefined> => {
    let firstError: Error | undefined;

    for (const cleanup of [...cleanups].reverse()) {
        try {
            await cleanup.run();
        } catch (error) {
            const normalized = normalizeError(error);
            failures.push({
                message: normalized.message,
                stage: `cleanup:${cleanup.name}`,
            });
            firstError ??= normalized;
        }
    }

    return firstError;
};

const writeReport = async (report: CanaryReport): Promise<void> => {
    const serialized = JSON.stringify(report, null, 2);
    await outputFile(report.reportPath, `${serialized}\n`);
};

export const runCanary = async ({
    buildPluginsRoot,
    cleanup,
    install,
    networkRetryDelaysMs,
    phaseSelection,
    reportPath,
    root,
    runCommand,
    runId,
    target,
}: {
    buildPluginsRoot: string;
    // Disposable CI checkouts skip reverting the target's changes.
    cleanup: boolean;
    install: boolean;
    networkRetryDelaysMs: number[];
    phaseSelection: string;
    reportPath: string;
    root: string;
    runCommand: RunCommand;
    runId: string;
    target: CanaryTarget;
}): Promise<CanaryReport> => {
    const startedAt = new Date().toISOString();
    const buildPluginsGit = await getGitState(buildPluginsRoot);
    const targetGit = await getGitState(root);
    const report: CanaryReport = {
        schemaVersion: 2,
        status: 'passed',
        target: target.id,
        phaseSelection,
        runId,
        startedAt,
        generatedAt: startedAt,
        reportPath,
        environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        repositories: {
            buildPlugins: {
                root: buildPluginsRoot,
                ...buildPluginsGit,
            },
            target: {
                root,
                ...targetGit,
            },
        },
        phases: [],
        failures: [],
    };
    const cleanups: Cleanup[] = [];
    const registerCleanup = (step: Cleanup): void => {
        cleanups.push(step);
    };
    const setupContext = {
        buildPluginsRoot,
        registerCleanup,
        root,
        runCommand,
    };
    let primaryError: Error | undefined;
    let stage = 'preflight';

    try {
        if (install) {
            stage = 'install';
            await withRetries(() => target.install(setupContext), networkRetryDelaysMs);
        }
        stage = 'preflight';
        await target.preflight(setupContext);
        stage = 'setup';
        await target.setup(setupContext);

        const allPhases = target.getPhases(root);
        const selectedPhases =
            phaseSelection === 'all'
                ? allPhases
                : allPhases.filter((phase) => phase.id === phaseSelection);
        if (selectedPhases.length === 0) {
            throw new CanaryCommandError(
                `Target ${target.id} does not define phase "${phaseSelection}".`,
            );
        }

        for (const phase of selectedPhases) {
            stage = `phase:${phase.id}`;
            const phaseReport = await runPhase({
                phase,
                root,
                runCommand,
                runId,
            });
            report.phases.push(phaseReport);
        }
    } catch (error) {
        primaryError = normalizeError(error);
        report.failures.push({
            message: primaryError.message,
            stage,
        });
    } finally {
        if (cleanup) {
            const cleanupError = await runCleanups(cleanups, report.failures);
            primaryError ??= cleanupError;
        } else if (cleanups.length > 0) {
            console.log(`\n[Canary] Skipping ${cleanups.length} cleanup step(s) (--no-cleanup).`);
        }
        report.status = report.failures.length === 0 ? 'passed' : 'failed';
        report.generatedAt = new Date().toISOString();

        try {
            await writeReport(report);
        } catch (error) {
            primaryError ??= normalizeError(error);
        }
    }

    if (primaryError) {
        throw primaryError;
    }

    return report;
};
