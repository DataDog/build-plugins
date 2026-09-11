// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile } from '@dd/core/helpers/fs';

import { CanaryCommandError } from '../runner';
import type { CanaryVariant, CommandResult } from '../types';

const ERROR_MARKERS = [
    'Instrumentation Error in ',
    'Failed to compose source map for ',
    'Invalid configuration for datadog-live-debugger-plugin',
];

export const assertLiveDebuggerBuildOutput = (
    result: CommandResult,
    variant: CanaryVariant,
): void => {
    for (const marker of ERROR_MARKERS) {
        if (result.output.includes(marker)) {
            throw new CanaryCommandError(
                `${variant} build reported a Live Debugger error containing "${marker}".`,
            );
        }
    }

    const summaryPattern =
        /Live Debugger: (\d+)\/(\d+) functions instrumented across (\d+)\/(\d+) files/g;
    const summaries = Array.from(result.output.matchAll(summaryPattern));
    if (variant === 'control') {
        if (summaries.length > 0) {
            throw new CanaryCommandError(
                'Control build unexpectedly ran Live Debugger instrumentation.',
            );
        }
        return;
    }

    const hasInstrumentation = summaries.some((summary) => {
        const instrumentedFunctions = Number(summary[1] ?? 0);
        const totalFunctions = Number(summary[2] ?? 0);
        const transformedFiles = Number(summary[3] ?? 0);
        return instrumentedFunctions > 0 && totalFunctions > 0 && transformedFiles > 0;
    });
    if (!hasInstrumentation) {
        throw new CanaryCommandError(
            'Instrumented build did not report any Live Debugger instrumentation.',
        );
    }
};

export const assertLiveDebuggerArtifacts = async (
    filePaths: string[],
    variant: CanaryVariant,
): Promise<void> => {
    if (variant === 'control') {
        return;
    }

    for (const filePath of filePaths) {
        const content = await readFile(filePath);
        if (content.includes('$dd_probes')) {
            return;
        }
    }

    throw new CanaryCommandError(
        'Instrumented build output does not contain the Live Debugger runtime marker.',
    );
};
