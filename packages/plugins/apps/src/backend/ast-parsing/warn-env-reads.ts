// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { BaseNode, Expression, MemberExpression, Super } from 'estree';

import { staticMemberName } from './ambient-global-access';
import { resolveIdentifier } from './module-scope';
import type { ModuleScopeAnalysis } from './module-scope';
import { ensureProgram } from './type-guards';
import { walkAst } from './walk-ast';

export const WHOLE_ENV_USE = 'process.env';
// A build-mode switch rather than a credential, so warning about it would only be noise.
const EXEMPT_KEYS = new Set(['NODE_ENV']);
const IDENTIFIER_KEY = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

// Every transform and local run re-checks a file, so each use is reported once per file; cleared wholesale once too large, to cap memory in long dev sessions.
export const MAX_TRACKED_FILES = 500;
const warnedUsesByFile = new Map<string, Set<string>>();

// Test-only escape hatch: clears the cross-call dedup cache between test cases that reuse the same file path.
export function resetEnvReadWarnings(): void {
    warnedUsesByFile.clear();
}

function isUnshadowed(node: Expression | Super, name: string, scope: ModuleScopeAnalysis): boolean {
    return node.type === 'Identifier' && node.name === name && !resolveIdentifier(node, scope);
}

function isProcessEnv(node: MemberExpression, scope: ModuleScopeAnalysis): boolean {
    if (staticMemberName(node, scope) !== 'env') {
        return false;
    }
    const { object } = node;
    if (isUnshadowed(object, 'process', scope)) {
        return true;
    }
    return (
        object.type === 'MemberExpression' &&
        staticMemberName(object, scope) === 'process' &&
        isUnshadowed(object.object, 'globalThis', scope)
    );
}

// Warns (never rejects) on `process.env` under v2, where production doesn't inject the developer's variables or Custom Credentials, so a value found locally is missing there.
export function warnAboutEnvReads(
    ast: BaseNode,
    filePath: string,
    log: Logger,
    scopeAnalysis: ModuleScopeAnalysis,
): void {
    const program = ensureProgram(ast, filePath);
    const uses = new Set<string>();
    const keyedEnvNodes = new Set<MemberExpression>();

    walkAst(program, null, {
        MemberExpression(node) {
            const object =
                node.object.type === 'ChainExpression' ? node.object.expression : node.object;
            if (object.type === 'MemberExpression' && isProcessEnv(object, scopeAnalysis)) {
                const key = staticMemberName(node, scopeAnalysis);
                if (key !== undefined) {
                    keyedEnvNodes.add(object);
                    if (!EXEMPT_KEYS.has(key)) {
                        const use = IDENTIFIER_KEY.test(key)
                            ? `process.env.${key}`
                            : `process.env[${JSON.stringify(key)}]`;
                        uses.add(use);
                    }
                }
            }
            if (!keyedEnvNodes.has(node) && isProcessEnv(node, scopeAnalysis)) {
                uses.add(WHOLE_ENV_USE);
            }
        },
    });

    reportNewUses(uses, filePath, log);
}

function reportNewUses(uses: ReadonlySet<string>, filePath: string, log: Logger): void {
    if (uses.size === 0) {
        return;
    }
    let warned = warnedUsesByFile.get(filePath);
    if (!warned) {
        if (warnedUsesByFile.size >= MAX_TRACKED_FILES) {
            warnedUsesByFile.clear();
        }
        warned = new Set<string>();
        warnedUsesByFile.set(filePath, warned);
    }

    const newUses = [...uses].filter((use) => !warned.has(use));
    if (newUses.length === 0) {
        return;
    }
    for (const use of newUses) {
        warned.add(use);
    }

    const useList = newUses.join(', ');
    log.warn(
        `${filePath} uses ${useList}. The v2 backend function runtime doesn't pass your ` +
            `environment variables or Custom Credentials to backend functions yet, so these ` +
            `see your shell's values locally but not in production.`,
    );
}
