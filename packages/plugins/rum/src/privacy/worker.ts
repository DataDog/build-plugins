// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { InstrumentationOptions } from '@datadog/js-instrumentation-wasm';
import type {
    WorkerBootstrapData,
    WorkerRequestMessage,
    WorkerResponseMessage,
} from '@dd/core/helpers/workerPool';
import { bootstrapWorkerRequire } from '@dd/core/helpers/workerPool';
import { parentPort, workerData } from 'worker_threads';

export interface RumPrivacyWorkerTask {
    id: string;
    code: string;
    map?: string | object;
}

export type RumPrivacyWorkerResult =
    | {
          unchanged: true;
          privacyDictionarySize: 0;
      }
    | {
          unchanged: false;
          code: string;
          map?: string;
          privacyDictionarySize: number;
      };

if (!parentPort) {
    throw new Error('rum-privacy-worker must be executed inside a worker_threads Worker');
}

const data = workerData as WorkerBootstrapData<InstrumentationOptions>;
const workerRequire = bootstrapWorkerRequire(data);
const { instrument } = workerRequire(
    '@datadog/js-instrumentation-wasm',
) as typeof import('@datadog/js-instrumentation-wasm');
const transformOptions = data.initData;

parentPort.on('message', (message: WorkerRequestMessage<RumPrivacyWorkerTask>) => {
    const { taskId, payload } = message;
    try {
        const serializedMap =
            payload.map === undefined || typeof payload.map === 'string'
                ? payload.map
                : JSON.stringify(payload.map);
        const result = instrument(
            { id: payload.id, code: payload.code, map: serializedMap },
            transformOptions,
        );

        const response: WorkerResponseMessage<RumPrivacyWorkerResult> =
            result.privacyDictionarySize === 0
                ? {
                      taskId,
                      ok: true,
                      result: {
                          unchanged: true,
                          privacyDictionarySize: 0,
                      },
                  }
                : {
                      taskId,
                      ok: true,
                      result: {
                          unchanged: false,
                          code: result.code,
                          map: result.map,
                          privacyDictionarySize: result.privacyDictionarySize,
                      },
                  };
        parentPort!.postMessage(response);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const response: WorkerResponseMessage<RumPrivacyWorkerResult> = {
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
