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
const HTML_SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

type ParsedSource = {
    callsProbes: boolean;
    assignsStub: boolean;
    inlinedSources: string[];
};

const isUnguarded = (code: string): boolean =>
    LIVE_DEBUGGER_PROBES_CALL_PATTERN.test(code) && !LIVE_DEBUGGER_PROBES_STUB_PATTERN.test(code);

const isProbesIdentifier = (node: Node): boolean =>
    node.type === 'Identifier' && node.name === LIVE_DEBUGGER_PROBES_FUNCTION;

const isStubAssignment = (node: Node): boolean => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression') {
        return false;
    }
    const { object, property, computed } = node.left;
    const isProbesProperty = computed
        ? property.type === 'StringLiteral' && property.value === LIVE_DEBUGGER_PROBES_FUNCTION
        : isProbesIdentifier(property);
    return object.type === 'Identifier' && object.name === 'globalThis' && isProbesProperty;
};

// Templates with non-literal substitutions can't be resolved, so they aren't checked.
const getInlinedSource = (node: Node): string | undefined => {
    if (node.type === 'StringLiteral' || node.type === 'DirectiveLiteral') {
        return node.value;
    }
    if (node.type !== 'TemplateLiteral') {
        return undefined;
    }
    let source = '';
    for (const [index, quasi] of node.quasis.entries()) {
        source += quasi.value.cooked ?? '';
        const expression = node.expressions[index];
        if (expression && expression.type !== 'StringLiteral') {
            return undefined;
        }
        source += expression?.value ?? '';
    }
    return source;
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

    const parsed: ParsedSource = { callsProbes: false, assignsStub: false, inlinedSources: [] };
    traverseFast(file as unknown as Node, (node) => {
        if (
            (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
            isProbesIdentifier(node.callee)
        ) {
            parsed.callsProbes = true;
        } else if (isStubAssignment(node)) {
            parsed.assignsStub = true;
        }

        const source = getInlinedSource(node);
        if (source !== undefined && LIVE_DEBUGGER_PROBES_CALL_PATTERN.test(source)) {
            parsed.inlinedSources.push(source);
        }
    });
    return parsed;
};

const isUnguardedParsed = (parsed: ParsedSource, depth: number): boolean =>
    (parsed.callsProbes && !parsed.assignsStub) ||
    (depth < MAX_INLINED_SOURCE_DEPTH &&
        parsed.inlinedSources.some((source) => isUnguardedSource(source, depth + 1)));

const isUnguardedSource = (source: string, depth: number): boolean => {
    const parsed = parseSource(source);
    if (parsed) {
        return isUnguardedParsed(parsed, depth);
    }

    const scripts = Array.from(source.matchAll(HTML_SCRIPT_PATTERN), ([, script]) => script);
    if (scripts.length === 0) {
        return isUnguarded(source);
    }
    // A script that doesn't parse can't be shown to install the stub, so it fails closed.
    return scripts.some((script) => {
        const parsedScript = parseSource(script);
        return parsedScript
            ? isUnguardedParsed(parsedScript, depth)
            : LIVE_DEBUGGER_PROBES_CALL_PATTERN.test(script);
    });
};

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
        if (parsed.callsProbes && !parsed.assignsStub) {
            throw new CanaryCommandError(
                `Instrumented build output calls ${LIVE_DEBUGGER_PROBES_FUNCTION} without a runtime stub: ${filePath}`,
            );
        }
        if (parsed.inlinedSources.some((source) => isUnguardedSource(source, 1))) {
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
