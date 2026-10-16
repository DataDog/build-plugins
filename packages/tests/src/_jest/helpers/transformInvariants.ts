// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parse } from '@babel/parser';
import { isCallExpression, isNewExpression, traverseFast } from '@babel/types';
import { Linter } from 'eslint';

// Checks that instrumentation leaves the behavior of the code it instruments intact,
// on top of producing valid JavaScript. They compare the code before and after a
// transform, so they apply to any input without knowing what it is supposed to do.

// The fall-through report Live Debugger appends at the end of a function body can
// follow a statement that already exits the function, which is harmless.
const TRAILING_RETURN_REPORT = /^if \(\$dd_p\d+\) \$dd_return\(/;
const PURE_ANNOTATION = /^\s*[#@]__PURE__\s*$/;

const linter = new Linter();
const UNREACHABLE_CODE_CONFIG: Linter.LegacyConfig = {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { 'no-unreachable': 'error' },
};

const getUnreachableStatements = (code: string): string[] => {
    const lines = code.split('\n');
    const messages = linter.verify(code, UNREACHABLE_CODE_CONFIG);
    const parseError = messages.find((message) => message.fatal);
    if (parseError) {
        throw new Error(`Cannot analyze code: ${parseError.message}`);
    }

    return messages
        .filter((message) => message.ruleId === 'no-unreachable')
        .map((message) => {
            const line = lines[message.line - 1] ?? '';
            return line.slice(message.column - 1).trim();
        })
        .filter((statement) => !TRAILING_RETURN_REPORT.test(statement));
};

// Returns the unreachable statements of `output` when it has more than `input`:
// a transform that moves an exit, like a return out of the `if` it belongs to,
// leaves code behind it that can never run.
export const getIntroducedUnreachableCode = (input: string, output: string): string[] => {
    const before = getUnreachableStatements(input);
    const after = getUnreachableStatements(output);
    return after.length > before.length ? after : [];
};

const parseCode = (code: string) => {
    return parse(code, { sourceType: 'unambiguous', plugins: ['jsx'] });
};

// Positions where bundlers honor a PURE annotation: the start of a call or `new`
// expression, and the outermost paren around one, as in `/* @__PURE__ */ (make())`.
const getAnnotationTargets = (ast: ReturnType<typeof parseCode>): Set<number> => {
    const targets = new Set<number>();
    traverseFast(ast, (node) => {
        if ((!isCallExpression(node) && !isNewExpression(node)) || node.start == null) {
            return;
        }
        targets.add(node.start);
        const parenStart = node.extra?.parenStart;
        if (typeof parenStart === 'number') {
            targets.add(parenStart);
        }
    });
    return targets;
};

const skipWhitespace = (code: string, position: number): number => {
    let next = position;
    while (next < code.length && /\s/.test(code[next])) {
        next++;
    }
    return next;
};

// Counts PURE annotations in a position where bundlers honor them. Babel attaches a
// comment at the start of a statement to the statement, so the position decides,
// not the comment's owner.
export const countAnnotatedCalls = (code: string): number => {
    const ast = parseCode(code);
    const targets = getAnnotationTargets(ast);
    const comments = ast.comments ?? [];
    return comments.filter((comment) => {
        if (!PURE_ANNOTATION.test(comment.value) || comment.end == null) {
            return false;
        }
        const next = skipWhitespace(code, comment.end);
        return targets.has(next);
    }).length;
};

// Puts a PURE annotation in every position where bundlers honor one, so that real
// code exercises each place where a transform inserts code next to an expression.
export const annotateCalls = (code: string): string => {
    const ast = parseCode(code);
    const targets = getAnnotationTargets(ast);
    const descendingTargets = [...targets].sort((a, b) => b - a);
    let annotated = code;
    for (const start of descendingTargets) {
        annotated = `${annotated.slice(0, start)}/* @__PURE__ */ ${annotated.slice(start)}`;
    }
    return annotated;
};
