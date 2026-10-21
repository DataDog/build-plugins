// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

declare const $: { Actions: { http: { request(call: unknown): Promise<unknown> } } };

export async function callHttp(connectionId?: string, delayMs = 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return $.Actions.http.request({ inputs: { url: 'https://example.com' }, connectionId });
}

export async function callHttpWithoutAwaiting() {
    $.Actions.http.request({ inputs: { url: 'https://example.com' } }).catch(() => {});
    return 'returned';
}

export async function callHttpWithMap() {
    return $.Actions.http.request({ inputs: { headers: new Map([['a', 'b']]) } });
}

export async function callHttpDeclaringScope() {
    return $.Actions.http.request({ inputs: { allowedConnectionIds: ['other'] } });
}

export async function callHttpDeclaringScopeViaToJson() {
    const inputs = { url: 'https://example.com', toJSON: () => ({ allowedConnectionIds: ['other'] }) };
    return $.Actions.http.request({ inputs });
}

export async function callHttpWithTopLevelToJson() {
    return $.Actions.http.request({ inputs: { toJSON: () => 'not an object' } });
}

// Sends an action request straight over the IPC channel, skipping $.Actions' own checks.
export async function forgeActionMessage(connectionId: string) {
    const id = 999_999;
    return new Promise((resolve) => {
        process.on('message', (message: { type?: string; id?: number }) => {
            if (message?.type === 'action-result' && message.id === id) {
                resolve(message);
            }
        });
        process.send?.({
            type: 'action',
            id,
            actionId: 'com.datadoghq.http.request',
            description: 'forged',
            inputs: {},
            connectionId,
        });
    });
}

export async function retryRefusedConnection() {
    for (;;) {
        try {
            return await $.Actions.http.request({ inputs: {}, connectionId: 'not-allowed' });
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}
