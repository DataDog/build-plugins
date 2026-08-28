// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { BaseNode } from 'estree';

import { forEachAmbientGlobalAccess } from './ambient-global-access';
import { analyzeModuleScope } from './module-scope';
import type { ModuleScopeAnalysis } from './module-scope';
import { ensureProgram } from './type-guards';

const DIVERGENT_GLOBALS = new Set(['crypto', 'Intl']);

// Cross-call cache since the same backend entry file is transformed multiple times per build; bounded and cleared wholesale once too large, trading an occasional re-warn for capped memory in long dev-server sessions.
const MAX_TRACKED_FILES = 500;
const warnedGlobalsByFile = new Map<string, Set<string>>();

// Test-only escape hatch: clears the cross-call dedup cache between test cases that reuse the same file path.
export function resetDivergentGlobalWarnings(): void {
    warnedGlobalsByFile.clear();
}

// Warns (never rejects) on `crypto`/`Intl` references in `.backend.ts` files, since their behavior can differ between local Node and production Deno. Editor-time guidance only — `npm run dev:verify`'s real cloud round trip is the actual parity gate.
export function warnAboutDivergentGlobals(
    ast: BaseNode,
    filePath: string,
    log: Logger,
    precomputedScopeAnalysis?: ModuleScopeAnalysis,
): void {
    const program = ensureProgram(ast, filePath);
    const scopeAnalysis = precomputedScopeAnalysis ?? analyzeModuleScope(program);

    let warned = warnedGlobalsByFile.get(filePath);
    if (!warned) {
        if (warnedGlobalsByFile.size >= MAX_TRACKED_FILES) {
            warnedGlobalsByFile.clear();
        }
        warned = new Set<string>();
        warnedGlobalsByFile.set(filePath, warned);
    }

    const warnOnce = (name: string) => {
        if (warned.has(name)) {
            return;
        }
        warned.add(name);
        warnDivergentGlobal(name, filePath, log);
    };

    forEachAmbientGlobalAccess(program, scopeAnalysis, DIVERGENT_GLOBALS, {
        onNamedAccess: warnOnce,
        onBulkCopy() {
            // No specific property to point at, so warn about every divergent global rather than staying silent.
            for (const name of DIVERGENT_GLOBALS) {
                warnOnce(name);
            }
        },
    });
}

function warnDivergentGlobal(name: string, filePath: string, log: Logger): void {
    log.warn(
        `"${name}" is used in ${filePath}. Its exact behavior can differ between local ` +
            `execution (Node) and production (Deno) — verify locale-/implementation-sensitive ` +
            `results with "npm run dev:verify" before publishing.`,
    );
}
