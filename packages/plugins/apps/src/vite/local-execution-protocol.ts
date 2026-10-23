// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { isIndexableRecord } from './local-execution-shared';

/** What the dev server sends a local execution child process to start one backend function call. */
export interface ChildStartConfig {
    moduleRunnerUrl: string;
    projectRoot: string;
    entryUrl: string;
    entryPath: string;
    functionName: string;
    args: unknown[];
    runtimeContext: Record<string, unknown>;
    actionCatalogInstalled: boolean;
    appsBackendInstalled: boolean;
    flushTimeoutMs: number;
}

export type ParentMessage =
    | { type: 'start'; config: ChildStartConfig }
    | { type: 'invoke-result'; id: number; response: unknown }
    | { type: 'action-result'; id: number; ok: true; value: unknown }
    | { type: 'action-result'; id: number; ok: false; message: string; thrownString: boolean };

export type ChildMessage =
    | { type: 'invoke'; id: number; payload: unknown }
    | {
          type: 'action';
          id: number;
          actionId: string;
          description: string;
          inputs: Record<string, unknown>;
          connectionId?: string;
      }
    | { type: 'loaded' }
    | { type: 'result'; data: unknown }
    | { type: 'error'; message: string; detail?: string };

// The child trusts the dev server, so this only tells the message kinds apart.
export function isParentMessage(message: unknown): message is ParentMessage {
    if (!isIndexableRecord(message)) {
        return false;
    }
    if (message.type === 'start') {
        return isIndexableRecord(message.config);
    }
    if (message.type === 'invoke-result') {
        return typeof message.id === 'number';
    }
    if (message.type === 'action-result') {
        return (
            typeof message.id === 'number' &&
            (message.ok === true || (message.ok === false && typeof message.message === 'string'))
        );
    }
    return false;
}
