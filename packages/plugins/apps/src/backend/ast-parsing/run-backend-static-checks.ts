// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { BaseNode } from 'estree';

import type { ModuleScopeAnalysis } from './module-scope';
import { rejectGlobalsMissingFromNode } from './reject-globals-missing-from-node';

/** Runs every static check against a single module; shared by every call site so the checks can't drift. */
export function runBackendStaticChecks(
    ast: BaseNode,
    filePath: string,
    log: Logger,
    scopeAnalysis: ModuleScopeAnalysis,
): void {
    rejectGlobalsMissingFromNode(ast, filePath, scopeAnalysis);
}
