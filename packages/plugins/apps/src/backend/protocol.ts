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
export const RUN_QUERY_KEEPALIVE = 'app-builder:run-query:keepalive';
export const PING = 'app-builder:ping';
export const PONG = 'app-builder:pong';

// The `globalThis` key where the dev client the dev server injects installs its call hook.
export const DEV_CLIENT_HOOK = 'DD_APPS_PREPARE_CALL';

export interface DebugBundleActionCall {
    /** Absent when the call sets no `connectionId`. */
    connectionId?: string;
    /**
     * Inline `inputs` keys set to a string literal or a top-level string const, such as
     * http.request's `url` and `verb`. Empty when `inputs` isn't an object literal of plain static
     * keys, the options or `inputs` literal has an accessor, or `inputs` has a toJSON, then or
     * __proto__ key. A hook inherited from a prototype or added by an executor wrapper isn't detected.
     */
    inputs: Record<string, string>;
}

export interface DebugBundleAction {
    fqn: string;
    connectionIds: string[];
    /** One entry per call site. */
    calls: DebugBundleActionCall[];
}

export interface DebugBundleResponse {
    code: string;
    allowedConnectionIds: string[];
    /**
     * A UX hint, not a security boundary. Lists the same direct action-catalog calls as
     * `allowedConnectionIds`, never `$.Actions` ones; absent when a call's FQN is unknown.
     */
    actions?: DebugBundleAction[];
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
