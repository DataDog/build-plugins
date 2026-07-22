// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env node, es2020 */

// child_process.fork() entry point for local backend-function execution.
// Plain JS (not TS) deliberately: this is the actual runtime artifact Node
// forks and executes directly, not source that goes through a build step.
//
// The $.Actions Proxy get/apply logic below is a direct Node port of
// domains/actionplatform/shared/libs/ts/highcode-script-template/render.ts's
// makeActionsProxy (dd-source) -- that logic has zero Deno dependencies and
// copies over verbatim. Only the transport changed: Deno.connect + hand-
// rolled HTTP/1.1 framing over a unix socket is replaced by fork()'s built-in
// structured-clone IPC channel (process.send()/process.on('message')).

let nextRequestId = 0;
const pending = new Map();

process.on('message', (msg) => {
    if (msg && msg.type === 'action-response') {
        const resolver = pending.get(msg.id);
        if (resolver) {
            pending.delete(msg.id);
            resolver(msg.payload);
        }
    }
});

function callAction(fqn, inputs, connectionId) {
    return new Promise((resolve, reject) => {
        const id = ++nextRequestId;
        pending.set(id, (payload) => {
            if (payload.type === 'success') {
                resolve(payload.result);
            } else {
                reject(payload.result);
            }
        });
        process.send({ type: 'action-request', id, fqn, inputs, connectionId });
    });
}

// Satisfies the exact contract packages/plugins/apps/src/backend/shared.ts's
// SET_EXECUTE_ACTION_SNIPPET expects: $.Actions must resolve any nested
// property path (e.g. $.Actions.slack.chat.postMessage) to a callable.
function makeActionsProxy(pathParts = []) {
    return new Proxy(function () {}, {
        get(_target, prop) {
            return makeActionsProxy(pathParts.concat(String(prop)));
        },
        apply(_target, _thisArg, args) {
            if (args.length === 0) {
                return Promise.reject(
                    `No arguments provided to action $.Actions.${pathParts.join('.')}`,
                );
            }
            const { inputs, connectionId } = args[0];
            if (typeof inputs !== 'object' || !inputs) {
                return Promise.reject(
                    `First argument to action $.Actions.${pathParts.join('.')} must have an inputs field`,
                );
            }
            const fqn = `com.datadoghq.${pathParts.join('.')}`;
            return callAction(fqn, inputs, connectionId);
        },
    });
}

process.on('message', async function onExecute(msg) {
    if (!msg || msg.type !== 'execute') {
        return;
    }

    try {
        const $ = { backendFunctionArgs: msg.backendFunctionArgs, Actions: makeActionsProxy() };
        globalThis.$ = $;

        // The real bundled code (from vite.build(), format:'es', no externals
        // for real npm deps -- see build-config.ts) is a plain ES module string
        // exporting `main`. Importing it as a data: URL avoids writing a temp
        // file. Verified empirically: this only works because Rollup inlines
        // every resolvable npm dependency (no `external` array configured) --
        // genuine Node built-ins (crypto, fs, etc.) are the only bare imports
        // left in real output, and those resolve fine from a data: URL since
        // they're resolved by scheme, not by filesystem context. A bare
        // specifier for an actual unresolved npm package would fail here with
        // "Failed to resolve module specifier" -- confirmed by direct test.
        const dataUrl = `data:text/javascript;base64,${Buffer.from(msg.scriptBody).toString('base64')}`;
        const mod = await import(dataUrl);
        const result = await mod.main($);

        process.send({ type: 'result', result });
        process.exit(0);
    } catch (err) {
        process.send({ type: 'error', error: String(err && err.message ? err.message : err) });
        process.exit(1);
    }
});
