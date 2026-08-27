// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { BaseNode } from 'estree';

import type { ModuleScopeAnalysis } from './module-scope';
import { rejectNodeBuiltinImports } from './reject-node-builtin-imports';
import { rejectRestrictedGlobals } from './reject-restricted-globals';
import { warnAboutDivergentGlobals } from './warn-divergent-globals';

/** Runs every static check (banned Node built-ins, restricted globals, divergent-global warnings) against a single module; shared by index.ts's entry-file transform and backend-static-checks-plugin.ts's module-graph traversal so the two call sites can't drift on which checks run or in what order. */
export function runBackendStaticChecks(
    ast: BaseNode,
    filePath: string,
    log: Logger,
    scopeAnalysis: ModuleScopeAnalysis,
): void {
    rejectNodeBuiltinImports(ast, filePath);
    rejectRestrictedGlobals(ast, filePath, scopeAnalysis);
    warnAboutDivergentGlobals(ast, filePath, log, scopeAnalysis);
}
