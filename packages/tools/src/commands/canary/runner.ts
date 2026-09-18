// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, readFile } from '@dd/core/helpers/fs';
import { execute } from '@dd/tools/helpers';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { glob } from 'glob';
import { performance } from 'perf_hooks';
import type { Readable, Writable } from 'stream';
import { gzipSync } from 'zlib';

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

export class StreamingCommandRunner {
    private activeChild: ChildProcess | undefined;

    cancel(signal: InterruptSignal): void {
        this.activeChild?.kill(signal);
    }

    run: RunCommand = async (spec) => {
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
                reject(error);
            });

            child.once('close', (exitCode, signal) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.activeChild = undefined;
                resolve({
                    durationMs: performance.now() - startedAt,
                    exitCode,
                    output,
                    signal,
                });
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

export const getVariantOrder = (runId: string, phaseId: string): CanaryVariant[] => {
    const key = `${runId}:${phaseId}`;
    return hash(key) % 2 === 0 ? ['control', 'instrumented'] : ['instrumented', 'control'];
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

    const validationCommand = phase.getValidationCommand(root, variant);
    await runCheckedCommand(runCommand, validationCommand);

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
    let control: VariantReport | undefined;
    let instrumented: VariantReport | undefined;

    for (const variant of variantOrder) {
        console.log(`\n[Canary] Running ${phase.id} ${variant} build.`);
        const result = await measureVariant({
            phase,
            root,
            runCommand,
            variant,
        });
        if (variant === 'control') {
            control = result;
        } else {
            instrumented = result;
        }
    }

    if (!control || !instrumented) {
        throw new CanaryCommandError(`${phase.id} did not produce both canary variants.`);
    }

    return {
        id: phase.id,
        buildTool: phase.buildTool,
        localPackages: phase.localPackages,
        variantOrder,
        variants: {
            control,
            instrumented,
        },
        comparison: createPhaseComparison(control, instrumented),
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
    phaseSelection,
    reportPath,
    root,
    runCommand,
    runId,
    target,
}: {
    buildPluginsRoot: string;
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
        schemaVersion: 1,
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
    const registerCleanup = (cleanup: Cleanup): void => {
        cleanups.push(cleanup);
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
        const cleanupError = await runCleanups(cleanups, report.failures);
        primaryError ??= cleanupError;
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
