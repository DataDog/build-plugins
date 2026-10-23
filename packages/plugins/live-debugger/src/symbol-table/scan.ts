// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { LIVE_DEBUGGER_PROBES_FUNCTION } from '@dd/core/constants';

import { LIVE_DEBUGGER_THROW_FUNCTION } from '../constants';

// An instrumented function found in a chunk's code.
export type ScannedFunction = {
    functionId: string;
    // Offset of the `$dd_probes('<id>')` call at the start of the function's body.
    probeOffset: number;
    // Offset of the `$dd_throw(` call at the end of the function's body.
    throwOffset: number | undefined;
    // Index of the enclosing instrumented function in the same list.
    parentIndex: number | undefined;
};

export type ChunkScan = {
    functions: ScannedFunction[];
    // False when the markers don't nest, so `throwOffset` and `parentIndex` can't be trusted.
    paired: boolean;
};

const escapeRegExp = (value: string) => value.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');

const MARKER_RX = new RegExp(
    `(${escapeRegExp(LIVE_DEBUGGER_PROBES_FUNCTION)}|${escapeRegExp(LIVE_DEBUGGER_THROW_FUNCTION)})\\s*\\(`,
    'g',
);
// A marker preceded by one of these is another identifier or a member access, not a call.
const NON_CALL_PREFIX_RX = /[\w$.]/;
// A marker preceded by this is a function declaration, not a call.
const FUNCTION_DECLARATION_SUFFIX_RX = /\bfunction\s*\*?\s*$/;
const FUNCTION_DECLARATION_LOOKBEHIND = 16;
// The runtime bootstrap injected into every chunk records the chunk's debug ID.
// Minifiers can drop the quotes around the key and change the quotes around the value.
const BUILD_METADATA_DEBUG_ID_RX =
    /__DD_LIVE_DEBUGGER_BUILD__\s*=\s*\{[^}]*?["']?debugId["']?\s*:\s*["']([0-9a-fA-F-]{36})["']/;

const QUOTES = new Set(["'", '"', '`']);
const WHITESPACE_RX = /\s/;
const HEX_RX = /^[0-9a-fA-F]+$/;
const SINGLE_CHARACTER_ESCAPES: Record<string, string> = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    0: '\0',
};
const LINE_CONTINUATIONS = new Set(['\n', '\u2028', '\u2029']);

type Decoded = {
    value: string;
    // Offset right after the decoded source text.
    end: number;
};

const skipWhitespace = (code: string, offset: number): number => {
    let index = offset;
    while (index < code.length && WHITESPACE_RX.test(code[index])) {
        index++;
    }
    return index;
};

const isCallSite = (code: string, offset: number): boolean => {
    if (offset > 0 && NON_CALL_PREFIX_RX.test(code[offset - 1])) {
        return false;
    }

    const lookbehindStart = Math.max(0, offset - FUNCTION_DECLARATION_LOOKBEHIND);
    const lookbehind = code.slice(lookbehindStart, offset);
    return !FUNCTION_DECLARATION_SUFFIX_RX.test(lookbehind);
};

const decodeCodePoint = (hex: string, end: number): Decoded | undefined => {
    if (!HEX_RX.test(hex)) {
        return undefined;
    }

    const codePoint = parseInt(hex, 16);
    if (codePoint > 0x10ffff) {
        return undefined;
    }

    return { value: String.fromCodePoint(codePoint), end };
};

// Decode the escape sequence whose backslash is right before `offset`.
const decodeEscape = (code: string, offset: number): Decoded | undefined => {
    const char = code[offset];
    if (char === undefined) {
        return undefined;
    }

    if (char === 'x') {
        const hex = code.slice(offset + 1, offset + 3);
        return hex.length === 2 ? decodeCodePoint(hex, offset + 3) : undefined;
    }

    if (char === 'u') {
        if (code[offset + 1] === '{') {
            const closingBrace = code.indexOf('}', offset + 2);
            if (closingBrace === -1) {
                return undefined;
            }
            const hex = code.slice(offset + 2, closingBrace);
            return decodeCodePoint(hex, closingBrace + 1);
        }

        const hex = code.slice(offset + 1, offset + 5);
        return hex.length === 4 ? decodeCodePoint(hex, offset + 5) : undefined;
    }

    if (char === '\r') {
        const end = code[offset + 1] === '\n' ? offset + 2 : offset + 1;
        return { value: '', end };
    }

    if (LINE_CONTINUATIONS.has(char)) {
        return { value: '', end: offset + 1 };
    }

    return { value: SINGLE_CHARACTER_ESCAPES[char] ?? char, end: offset + 1 };
};

// Decode the string literal starting at `offset`, which must be its opening quote.
const decodeStringLiteral = (code: string, offset: number): Decoded | undefined => {
    const quote = code[offset];
    if (!QUOTES.has(quote)) {
        return undefined;
    }

    const isTemplate = quote === '`';
    let value = '';
    let index = offset + 1;
    let segmentStart = index;

    while (index < code.length) {
        const char = code[index];

        if (char === quote) {
            value += code.slice(segmentStart, index);
            return { value, end: index + 1 };
        }

        if (char === '\\') {
            value += code.slice(segmentStart, index);
            const escape = decodeEscape(code, index + 1);
            if (!escape) {
                return undefined;
            }
            value += escape.value;
            index = escape.end;
            segmentStart = index;
            continue;
        }

        // Only constant strings are function IDs.
        if (isTemplate && char === '$' && code[index + 1] === '{') {
            return undefined;
        }

        if (!isTemplate && (char === '\n' || char === '\r')) {
            return undefined;
        }

        index++;
    }

    return undefined;
};

// Read the function ID of a `$dd_probes('<id>')` call, from right after its opening parenthesis.
const readFunctionIdArgument = (code: string, offset: number): string | undefined => {
    const literalStart = skipWhitespace(code, offset);
    const literal = decodeStringLiteral(code, literalStart);
    if (!literal) {
        return undefined;
    }

    const closingParenthesis = skipWhitespace(code, literal.end);
    return code[closingParenthesis] === ')' ? literal.value : undefined;
};

/**
 * Find the instrumented functions in a chunk's code, without parsing it.
 *
 * Every instrumented function contains exactly one `$dd_probes('<id>')` call at the start of its
 * body and one `$dd_throw(` call at its end, in the injected `catch`. Minifiers keep both, because
 * they are calls to globals. Pairing them like brackets gives each function's extent, and the
 * nesting gives its enclosing function.
 */
export const scanChunk = (code: string): ChunkScan => {
    const functions: ScannedFunction[] = [];
    const openFunctions: number[] = [];
    let paired = true;

    for (const match of code.matchAll(MARKER_RX)) {
        const offset = match.index;
        if (!isCallSite(code, offset)) {
            continue;
        }

        if (match[1] === LIVE_DEBUGGER_PROBES_FUNCTION) {
            const argumentOffset = offset + match[0].length;
            const functionId = readFunctionIdArgument(code, argumentOffset);
            if (functionId === undefined) {
                continue;
            }

            functions.push({
                functionId,
                probeOffset: offset,
                throwOffset: undefined,
                parentIndex: openFunctions.at(-1),
            });
            openFunctions.push(functions.length - 1);
            continue;
        }

        const closedFunction = openFunctions.pop();
        if (closedFunction === undefined) {
            paired = false;
            continue;
        }
        functions[closedFunction].throwOffset = offset;
    }

    if (openFunctions.length > 0) {
        paired = false;
    }

    return { functions, paired };
};

// Read the chunk's debug ID from the runtime bootstrap.
export const readChunkDebugId = (code: string): string | undefined => {
    return BUILD_METADATA_DEBUG_ID_RX.exec(code)?.[1];
};
