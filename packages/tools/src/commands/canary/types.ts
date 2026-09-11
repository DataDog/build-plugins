// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const CANARY_VARIANTS = ['control', 'instrumented'] as const;
export type CanaryVariant = (typeof CANARY_VARIANTS)[number];
export type InterruptSignal = 'SIGINT' | 'SIGTERM';

export type CommandSpec = {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string | undefined>;
    label: string;
};

export type CommandResult = {
    durationMs: number;
    exitCode: number | null;
    output: string;
    signal: string | null;
};

export type RunCommand = (spec: CommandSpec) => Promise<CommandResult>;

export type ArtifactSpec = {
    roots: string[];
    patterns: string[];
};

export type ArtifactMeasurement = {
    fileCount: number;
    gzipBytes: number;
    rawBytes: number;
};

export type VariantMeasurement = ArtifactMeasurement & {
    durationMs: number;
};

export type MetricComparison = {
    control: number;
    instrumented: number;
    delta: number;
    deltaPercent: number | null;
};

export type PhaseComparison = {
    durationMs: MetricComparison;
    gzipBytes: MetricComparison;
    rawBytes: MetricComparison;
};

export type CanaryPhase = {
    id: string;
    buildTool: string;
    localPackages: string[];
    getArtifactSpec: (root: string, variant: CanaryVariant) => ArtifactSpec;
    getBuildCommand: (root: string, variant: CanaryVariant) => CommandSpec;
    getValidationCommand: (root: string, variant: CanaryVariant) => CommandSpec;
    assertBuildOutput: (result: CommandResult, variant: CanaryVariant) => void;
    assertArtifacts?: (filePaths: string[], variant: CanaryVariant) => Promise<void>;
};

export type Cleanup = {
    name: string;
    run: () => Promise<void>;
};

export type RegisterCleanup = (cleanup: Cleanup) => void;

export type TargetSetupContext = {
    buildPluginsRoot: string;
    registerCleanup: RegisterCleanup;
    root: string;
    runCommand: RunCommand;
};

export type CanaryTarget = {
    id: string;
    getDefaultRoot: () => string;
    getPhases: (root: string) => CanaryPhase[];
    preflight: (context: TargetSetupContext) => Promise<void>;
    setup: (context: TargetSetupContext) => Promise<void>;
};

export type VariantReport = VariantMeasurement & {
    outputRoots: string[];
};

export type PhaseReport = {
    id: string;
    buildTool: string;
    localPackages: string[];
    variantOrder: CanaryVariant[];
    variants: Record<CanaryVariant, VariantReport>;
    comparison: PhaseComparison;
};

export type CanaryFailure = {
    message: string;
    stage: string;
};

export type CanaryReport = {
    schemaVersion: 1;
    status: 'passed' | 'failed';
    target: string;
    phaseSelection: string;
    runId: string;
    startedAt: string;
    generatedAt: string;
    reportPath: string;
    environment: {
        node: string;
        platform: string;
        arch: string;
    };
    repositories: {
        buildPlugins: {
            root: string;
            commit: string;
            dirty: boolean;
        };
        target: {
            root: string;
            commit: string;
            dirty: boolean;
        };
    };
    phases: PhaseReport[];
    failures: CanaryFailure[];
};
