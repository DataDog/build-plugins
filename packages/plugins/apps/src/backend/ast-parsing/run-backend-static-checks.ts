// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { BaseNode } from 'estree';

import type { ModuleScopeAnalysis } from './module-scope';
import { rejectGlobalsMissingFromNode } from './reject-globals-missing-from-node';
import { type WarnedEnvReads, warnAboutEnvReads } from './warn-env-reads';

export type RunBackendStaticChecks = (
    ast: BaseNode,
    filePath: string,
    scopeAnalysis: ModuleScopeAnalysis,
) => void;

/** Create one per plugin instance and share it across call sites, so the checks can't drift and each warning shows once. */
export function createBackendStaticChecks(log: Logger): RunBackendStaticChecks {
    const warnedEnvReads: WarnedEnvReads = new Map();
    return (ast, filePath, scopeAnalysis) => {
        rejectGlobalsMissingFromNode(ast, filePath, scopeAnalysis);
        warnAboutEnvReads(ast, filePath, log, scopeAnalysis, warnedEnvReads);
    };
}
