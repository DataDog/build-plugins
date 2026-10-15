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

export const DEBUG_BUNDLE_PATH = '/__dd/debugBundle';

// Message types of the frame ↔ parent postMessage protocol.
export const RUN_QUERY = 'app-builder:run-query';
export const RUN_QUERY_RESPONSE = 'app-builder:run-query:response';
export const PING = 'app-builder:ping';
export const PONG = 'app-builder:pong';

// The `globalThis` key where the dev client the dev server injects installs its call hook.
export const DEV_CLIENT_HOOK = 'DD_APPS_PREPARE_CALL';

export interface DebugBundleResponse {
    code: string;
    allowedConnectionIds: string[];
}

// Asks the parent to identify itself: its pong's `event.origin` is set by the browser.
export type IframeQueryPing = {
    type: typeof PING;
    requestId: string;
};

// What the dev client adds to a call before the transport posts it.
export type PreparedCall = { targetOrigin?: string; bundle?: DebugBundleResponse };

// The hook the dev client installs under DEV_CLIENT_HOOK.
export type PrepareCall = (functionName: string) => Promise<PreparedCall>;

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
