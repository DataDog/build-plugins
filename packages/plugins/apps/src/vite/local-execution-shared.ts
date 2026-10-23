// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global Proxy */

// Side-effect free, so the local execution child process can bundle it without the in-process path's `$` accessor.

export interface ActionCallArgs {
    inputs: Record<string, unknown>;
    connectionId?: string;
}

/** Dispatches one `$.Actions` call; `actionDescription` names the call in error messages. */
export type ActionDispatch = (
    actionId: string,
    call: Partial<ActionCallArgs>,
    actionDescription: string,
) => Promise<unknown>;

/** Narrows an unknown value enough to read named properties off it by key. */
export function isIndexableRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Rejects the way a deployed `$.Actions` call does: with a bare string, not an Error. */
export function throwActionFailure(message: string): never {
    throw message;
}

/** The backend function's own code threw; `detail` is what a deployed app reports after "Execution failed: ". */
export class FunctionThrewError extends Error {
    constructor(
        message: string,
        readonly detail: string,
    ) {
        super(message);
    }
}

function describeThrown(thrown: unknown): { message: string; detail: string } {
    try {
        if (thrown instanceof Error) {
            const detail = typeof thrown.stack === 'string' ? thrown.stack : String(thrown);
            return { message: String(thrown.message), detail };
        }
        const text = String(thrown);
        return { message: text, detail: text };
    } catch {
        return { message: 'Unknown error', detail: 'Unknown error' };
    }
}

export async function callBackendFunction(call: () => unknown): Promise<unknown> {
    try {
        return await call();
    } catch (thrown) {
        const { message, detail } = describeThrown(thrown);
        throw new FunctionThrewError(message, detail);
    }
}

/** Checks this one call's own connectionId field against the function's allowlist — not full parity with the cloud path's server-side restriction, since a nested meta-action's own inputs can carry a separate scope this never inspects (see validateActionCall's own check for that). */
export function assertConnectionIdAllowed(
    connectionId: string | undefined,
    allowedConnectionIds: string[],
    actionDescription: string,
): void {
    if (connectionId !== undefined && !allowedConnectionIds.includes(connectionId)) {
        throwActionFailure(
            `Action ${actionDescription} used connection "${connectionId}", which is not in this function's allowed connections: [${allowedConnectionIds.join(', ')}]`,
        );
    }
}

/** Rejects a top-level `allowedConnectionIds` key on `inputs`, not one nested deeper. Checked before serialization and again after, since a custom `toJSON()` can introduce the key. */
export function assertNoSelfDeclaredScope(
    inputs: Record<string, unknown>,
    actionDescription: string,
): void {
    // Own-property check, so a polluted Object.prototype can't make every call appear to declare it.
    if (Object.prototype.hasOwnProperty.call(inputs, 'allowedConnectionIds')) {
        throw new Error(
            `Action ${actionDescription} must not declare its own allowedConnectionIds in inputs — this function's own allowlist already governs which connections it can use.`,
        );
    }
}

/** The allowlist-free part of `validateActionCall`, for a caller that doesn't hold the allowlist. */
export function validateActionCallShape(
    call: Partial<ActionCallArgs>,
    actionDescription: string,
): { inputs: Record<string, unknown>; connectionId: string | undefined } {
    const { inputs, connectionId } = call;
    if (typeof inputs !== 'object' || !inputs) {
        throwActionFailure(
            `First argument to action ${actionDescription} must have an inputs field that is an object`,
        );
    }
    assertNoSelfDeclaredScope(inputs, actionDescription);
    return { inputs, connectionId };
}

/** Shared validation for both $.Actions entry points (raw proxy and action-catalog typed wrapper) — extracted so a contract change can't be applied to one path and missed on the other. */
export function validateActionCall(
    call: Partial<ActionCallArgs>,
    allowedConnectionIds: string[],
    actionDescription: string,
): { inputs: Record<string, unknown>; connectionId: string | undefined } {
    const { inputs, connectionId } = validateActionCallShape(call, actionDescription);
    assertConnectionIdAllowed(connectionId, allowedConnectionIds, actionDescription);
    return { inputs, connectionId };
}

/** JSON round-trips `$.Actions` inputs with the same strict validation as a return value (`assertJsonRoundTrippable`), so a Map/Set/NaN/symbol-keyed input fails loudly instead of reaching the destination corrupted. Also re-checks the round-tripped shape, since a top-level `toJSON()` can turn an object into a string/array. */
export function serializeActionInputs(
    inputs: Record<string, unknown>,
    actionDescription: string,
): Record<string, unknown> {
    const subject = `Inputs to action ${actionDescription}`;
    const roundTripped = assertJsonRoundTrippable(inputs, subject);
    if (!isIndexableRecord(roundTripped) || Array.isArray(roundTripped)) {
        throw new Error(
            `${subject} must be a plain object after JSON round-tripping, but a custom toJSON() changed its top-level shape to ${Array.isArray(roundTripped) ? 'an array' : roundTripped === null ? 'null' : typeof roundTripped} — return a plain JSON-compatible object instead.`,
        );
    }
    return roundTripped;
}

/** Resolves a `$.Actions` path to a callable that hands the call to `dispatch`. */
export function makeActionsProxy(dispatch: ActionDispatch, pathParts: string[] = []): unknown {
    return new Proxy(function () {}, {
        get(_target, prop) {
            // Must not look thenable/serializable — Promise/assertJsonSerializable probes for
            // .then()/.toJSON() would otherwise hit apply() below and hang or leak a rejection.
            if (prop === 'then' || prop === 'toJSON') {
                return undefined;
            }
            const nestedPathParts = pathParts.concat(String(prop));
            return makeActionsProxy(dispatch, nestedPathParts);
        },
        async apply(_target, _thisArg, args: unknown[]) {
            const actionPath = pathParts.join('.');
            if (args.length === 0) {
                throwActionFailure(`No arguments provided to action $.Actions.${actionPath}`);
            }
            const call: Partial<ActionCallArgs> = isIndexableRecord(args[0]) ? args[0] : {};
            const fqn = `com.datadoghq.${actionPath}`;
            return dispatch(fqn, call, `$.Actions.${actionPath}`);
        },
    });
}

/** Rejects a non-JSON-serializable result (circular reference, `BigInt`, a dropped function/`Symbol`, a `Map`/`Set` flattened to `{}`) here with a clear error, instead of failing downstream when serialized for the HTTP response. */
// Lets the replacer's already-specific message pass through the outer catch below unwrapped, instead of being replaced by its generic fallback.
class UnsupportedJsonValueError extends Error {}

/**
 * Shared by a function's return value and its `$.Actions` call inputs — both cross a JSON boundary
 * and need the same protection against JSON.stringify's silent corruption (Map/Set flattened to
 * `{}`, non-finite numbers to `null`, functions/symbols/`undefined` dropped, symbol-keyed
 * properties omitted) rather than a bare `JSON.parse(JSON.stringify(...))` that would let corrupted
 * data pass through unnoticed. `subject` names what's being checked for the thrown error message.
 */
export function assertJsonRoundTrippable(value: unknown, subject: string): unknown {
    let serialized: string | undefined;
    try {
        // Visits every key/value pair including the root, catching a disallowed value at any
        // depth. Root is tracked via a one-shot flag, not `key === ''`, since a real property can
        // itself be named `''`.
        let isRootCall = true;
        serialized = JSON.stringify(value, function (key, childValue) {
            const wasRootCall = isRootCall;
            isRootCall = false;
            // Checked on `childValue` (a custom toJSON()'s return value, not necessarily the
            // original object) since the replacer never runs for a symbol-keyed property at all —
            // a symbol key introduced only by toJSON() would otherwise go undetected.
            if (
                childValue !== null &&
                typeof childValue === 'object' &&
                Object.getOwnPropertySymbols(childValue).length > 0
            ) {
                throw new UnsupportedJsonValueError(
                    `${subject} contains a Symbol-keyed property${key ? ` (at "${key}")` : ''}, which JSON.stringify silently drops instead of serializing — use a plain JSON-compatible value instead.`,
                );
            }
            if (childValue instanceof Map || childValue instanceof Set) {
                throw new UnsupportedJsonValueError(
                    `${subject} contains a ${childValue.constructor.name}${key ? ` (at "${key}")` : ''}, which JSON.stringify silently flattens to "{}" instead of serializing its entries — use a plain array or object instead.`,
                );
            }
            if (typeof childValue === 'number' && !Number.isFinite(childValue)) {
                throw new UnsupportedJsonValueError(
                    `${subject} contains ${childValue}${key ? ` (at "${key}")` : ''}, which JSON.stringify silently converts to "null" instead of throwing — use a finite number instead.`,
                );
            }
            // A plain object property holding `undefined` is silently omitted by JSON.stringify —
            // matching production's own serialization, so it's not flagged (unlike an array
            // element, where `undefined` is converted to `null` instead of dropped).
            if (!wasRootCall && childValue === undefined && Array.isArray(this)) {
                throw new UnsupportedJsonValueError(
                    `${subject} contains undefined inside an array (at index ${key}), which JSON.stringify silently converts to null instead of dropping it — use null explicitly instead.`,
                );
            }
            if (
                !wasRootCall &&
                (typeof childValue === 'function' || typeof childValue === 'symbol') &&
                Array.isArray(this)
            ) {
                throw new UnsupportedJsonValueError(
                    `${subject} contains a ${typeof childValue} inside an array (at index ${key}), which JSON.stringify silently converts to null instead of dropping it — use null explicitly instead.`,
                );
            }
            if (
                !wasRootCall &&
                (typeof childValue === 'function' || typeof childValue === 'symbol') &&
                !Array.isArray(this)
            ) {
                throw new UnsupportedJsonValueError(
                    `${subject} contains a ${typeof childValue} (at "${key}"), which JSON.stringify silently drops instead of serializing — use a plain JSON-compatible value instead.`,
                );
            }
            return childValue;
        });
    } catch (err) {
        if (err instanceof UnsupportedJsonValueError) {
            throw err;
        }
        throw new Error(
            `${subject} can't be serialized to JSON: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
    if (serialized === undefined) {
        if (value !== undefined) {
            throw new Error(
                `${subject} is a ${typeof value} value, which JSON.stringify silently drops instead of serializing — use a plain JSON-compatible value instead.`,
            );
        }
        return undefined;
    }
    // Return the parsed-and-reserialized value, not the original — a caller serializing again
    // for the HTTP response (or the executeAction call) would otherwise invoke a custom toJSON() a second time.
    return JSON.parse(serialized);
}

/** The subject `assertJsonRoundTrippable` names for a function's return value. */
export function returnValueSubject(functionName: string): string {
    return `Local execution of "${functionName}"'s return value`;
}
