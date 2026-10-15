// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parse } from '@babel/parser';
import { traverseFast } from '@babel/types';
import type { Node } from '@babel/types';
import {
    LIVE_DEBUGGER_PROBES_CALL_PATTERN,
    LIVE_DEBUGGER_PROBES_FUNCTION,
    LIVE_DEBUGGER_PROBES_STUB_PATTERN,
} from '@dd/core/constants';
import { readFile } from '@dd/core/helpers/fs';

import { CanaryCommandError } from '../runner';
import type { CanaryVariant, CommandResult } from '../types';

const MAX_INLINED_SOURCE_DEPTH = 3;

type ParsedSource = {
    // Strings and comments blanked, so a stub inside them can't guard the outer code.
    outerCode: string;
    inlinedSources: string[];
};

const isUnguarded = (code: string): boolean =>
    LIVE_DEBUGGER_PROBES_CALL_PATTERN.test(code) && !LIVE_DEBUGGER_PROBES_STUB_PATTERN.test(code);

const getStringValue = (node: Node): string | undefined => {
    switch (node.type) {
        case 'StringLiteral':
        case 'DirectiveLiteral':
            return node.value;
        case 'TemplateElement':
            return node.value.cooked ?? node.value.raw;
        default:
            return undefined;
    }
};

// Bundles inlined as strings (iframe `srcdoc`, worker sources) share their parent chunk's
// file, so the parent's stub would otherwise hide their missing one.
const parseSource = (code: string): ParsedSource | undefined => {
    let file: ReturnType<typeof parse>;
    try {
        file = parse(code, { sourceType: 'unambiguous', errorRecovery: true });
    } catch {
        return undefined;
    }

    const blankedRanges: [number, number][] = [];
    const blank = ({ start, end }: { start?: number | null; end?: number | null }): void => {
        if (typeof start === 'number' && typeof end === 'number') {
            blankedRanges.push([start, end]);
        }
    };
    file.comments?.forEach(blank);

    const inlinedSources: string[] = [];
    traverseFast(file as unknown as Node, (node) => {
        if (node.type === 'TemplateLiteral') {
            const source = node.quasis.map((quasi) => quasi.value.cooked ?? '').join('');
            if (LIVE_DEBUGGER_PROBES_CALL_PATTERN.test(source)) {
                inlinedSources.push(source);
            }
            return;
        }
        const value = getStringValue(node);
        if (value === undefined) {
            return;
        }
        blank(node);
        if (node.type !== 'TemplateElement' && LIVE_DEBUGGER_PROBES_CALL_PATTERN.test(value)) {
            inlinedSources.push(value);
        }
    });

    let outerCode = '';
    let cursor = 0;
    for (const [start, end] of blankedRanges.sort(([a], [b]) => a - b)) {
        outerCode += `${code.slice(cursor, start)}""`;
        cursor = end;
    }
    outerCode += code.slice(cursor);
    return { outerCode, inlinedSources };
};

const hasUnguardedInlinedSource = (sources: string[], depth: number): boolean =>
    sources.some((source) => {
        // Sources that don't parse as JS (an HTML `srcdoc`) are checked as plain text.
        const parsed = depth < MAX_INLINED_SOURCE_DEPTH ? parseSource(source) : undefined;
        if (!parsed) {
            return isUnguarded(source);
        }
        return (
            isUnguarded(parsed.outerCode) ||
            hasUnguardedInlinedSource(parsed.inlinedSources, depth + 1)
        );
    });

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

    let hasRuntimeMarker = false;
    for (const filePath of filePaths) {
        const content = await readFile(filePath);
        if (content.includes(LIVE_DEBUGGER_PROBES_FUNCTION)) {
            hasRuntimeMarker = true;
        }
        if (!LIVE_DEBUGGER_PROBES_CALL_PATTERN.test(content)) {
            continue;
        }

        const parsed = parseSource(content);
        if (!parsed) {
            throw new CanaryCommandError(
                `Could not parse instrumented build output to check inlined code: ${filePath}`,
            );
        }
        if (isUnguarded(parsed.outerCode)) {
            throw new CanaryCommandError(
                `Instrumented build output calls ${LIVE_DEBUGGER_PROBES_FUNCTION} without a runtime stub: ${filePath}`,
            );
        }
        if (hasUnguardedInlinedSource(parsed.inlinedSources, 1)) {
            throw new CanaryCommandError(
                `Instrumented build output inlines code that calls ${LIVE_DEBUGGER_PROBES_FUNCTION} without a runtime stub: ${filePath}`,
            );
        }
    }

    if (!hasRuntimeMarker) {
        throw new CanaryCommandError(
            'Instrumented build output does not contain the Live Debugger runtime marker.',
        );
    }
};
