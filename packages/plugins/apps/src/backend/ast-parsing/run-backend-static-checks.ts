// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { BaseNode } from 'estree';

import type { BackendRuntimeStatus } from '../../backend-runtime';
import { RUNTIME_FALLBACK_NOTE } from '../../runtime-names';

import type { ModuleScopeAnalysis } from './module-scope';
import { rejectNodeBuiltinImports } from './reject-node-builtin-imports';
import {
    isMissingFromNode,
    rejectGlobalsMissingFromNode,
    rejectRestrictedGlobals,
    RestrictedGlobalError,
} from './reject-restricted-globals';
import { warnAboutDivergentGlobals } from './warn-divergent-globals';
import { warnAboutEnvReads } from './warn-env-reads';

/** Shared by every call site so the checks can't drift. Any runtime other than v2 gets the v1 checks, so an unknown one fails closed. */
export function runBackendStaticChecks(
    ast: BaseNode,
    filePath: string,
    log: Logger,
    scopeAnalysis: ModuleScopeAnalysis,
    { runtime, isFallback }: BackendRuntimeStatus,
): void {
    if (runtime === 'v2') {
        rejectGlobalsMissingFromNode(ast, filePath, scopeAnalysis);
        warnAboutEnvReads(ast, filePath, log, scopeAnalysis);
        return;
    }
    try {
        rejectNodeBuiltinImports(ast, filePath);
        rejectRestrictedGlobals(ast, filePath, scopeAnalysis);
    } catch (error) {
        const v2RejectsToo =
            error instanceof RestrictedGlobalError && isMissingFromNode(error.globalName);
        if (!isFallback || !(error instanceof Error) || v2RejectsToo) {
            throw error;
        }
        throw new Error(`${error.message} (${RUNTIME_FALLBACK_NOTE}).`, { cause: error });
    }
    warnAboutDivergentGlobals(ast, filePath, log, scopeAnalysis);
}
