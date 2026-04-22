// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Wire protocol for backend function execution shared by the dev server,
 * the dev-server transport, and the iframe postMessage transport.
 *
 * Lives at the backend/ root (above client/) so server-side and client-side
 * code can both depend on it without one importing through the other.
 */

/**
 * Request payload for executing a backend function.
 */
export interface ExecuteActionRequest {
    functionName: string;
    args: unknown[];
}

/**
 * Response from executing a backend function.
 *
 * The `data` wrapper inside `result` mirrors the Datadog app-builder
 * `preview-async` queries API contract: a JS action's return value is
 * surfaced as `outputs: { data: <value> }`. Both transports unwrap `.data`.
 */
export type ExecuteActionResponse<TData = unknown> =
    | {
          success: true;
          result: {
              data: TData;
          };
      }
    | {
          success: false;
          error: string;
      };
