// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    WorkerBootstrapData,
    WorkerRequestMessage,
    WorkerResponseMessage,
} from '@dd/core/helpers/workerPool';
import { bootstrapWorkerRequire } from '@dd/core/helpers/workerPool';
import type { SourceMapInput } from '@jridgewell/remapping';
import type { SourceMap } from 'magic-string';
import type { SourceMapCompact } from 'unplugin';
import { parentPort, workerData } from 'worker_threads';

import type { DecoratorSyntax, FunctionKind } from '../types';

import { setTransformRequire, transformCode } from './index';

export interface LiveDebuggerWorkerInitData {
    honorSkipComments: boolean;
    functionTypes: FunctionKind[] | undefined;
    namedOnly: boolean;
    decorators: DecoratorSyntax;
    exceptionReplay: boolean;
}

export interface LiveDebuggerWorkerTask {
    code: string;
    filePath: string;
    repositoryRoot: string;
    inputMap?: SourceMapInput;
}

export interface LiveDebuggerWorkerResult {
    unchanged: boolean;
    code?: string;
    map?: SourceMapCompact | SourceMap;
    mapComposeError?: string;
    failedCount: number;
    instrumentedCount: number;
    skippedByCommentCount: number;
    skippedFileCount: number;
    skippedUnsupportedCount: number;
    totalFunctions: number;
}

if (!parentPort) {
    throw new Error('live-debugger-worker must be executed inside a worker_threads Worker');
}

const data = workerData as WorkerBootstrapData<LiveDebuggerWorkerInitData>;
const workerRequire = bootstrapWorkerRequire(data);
setTransformRequire(workerRequire);

const remappingMod = workerRequire('@jridgewell/remapping') as
    | typeof import('@jridgewell/remapping').default
    | { default: typeof import('@jridgewell/remapping').default };
const remapping = typeof remappingMod === 'function' ? remappingMod : remappingMod.default;
const initData = data.initData;

parentPort.on('message', (message: WorkerRequestMessage<LiveDebuggerWorkerTask>) => {
    const { taskId, payload } = message;
    try {
        const result = transformCode({
            code: payload.code,
            filePath: payload.filePath,
            repositoryRoot: payload.repositoryRoot,
            honorSkipComments: initData.honorSkipComments,
            functionTypes: initData.functionTypes,
            namedOnly: initData.namedOnly,
            decorators: initData.decorators,
            exceptionReplay: initData.exceptionReplay,
        });

        if (result.instrumentedCount === 0) {
            const response: WorkerResponseMessage<LiveDebuggerWorkerResult> = {
                taskId,
                ok: true,
                result: {
                    unchanged: true,
                    failedCount: result.failedCount,
                    instrumentedCount: 0,
                    skippedByCommentCount: result.skippedByCommentCount,
                    skippedFileCount: result.skippedFileCount,
                    skippedUnsupportedCount: result.skippedUnsupportedCount,
                    totalFunctions: result.totalFunctions,
                },
            };
            parentPort!.postMessage(response);
            return;
        }

        let composedMap: SourceMapCompact | SourceMap | undefined = result.map;
        let mapComposeError: string | undefined;
        if (result.map && payload.inputMap) {
            try {
                composedMap = remapping(result.map as unknown as SourceMapInput, (_file, ctx) =>
                    ctx.depth === 1 ? payload.inputMap! : null,
                ) as unknown as SourceMapCompact;
            } catch (e) {
                mapComposeError = String(e);
                composedMap = result.map;
            }
        }

        const response: WorkerResponseMessage<LiveDebuggerWorkerResult> = {
            taskId,
            ok: true,
            result: {
                unchanged: false,
                code: result.code,
                map: composedMap,
                mapComposeError,
                failedCount: result.failedCount,
                instrumentedCount: result.instrumentedCount,
                skippedByCommentCount: result.skippedByCommentCount,
                skippedFileCount: result.skippedFileCount,
                skippedUnsupportedCount: result.skippedUnsupportedCount,
                totalFunctions: result.totalFunctions,
            },
        };
        parentPort!.postMessage(response);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const response: WorkerResponseMessage<LiveDebuggerWorkerResult> = {
            taskId,
            ok: false,
            error: {
                message: err.message,
                name: err.name,
                stack: err.stack,
            },
        };
        parentPort!.postMessage(response);
    }
});
