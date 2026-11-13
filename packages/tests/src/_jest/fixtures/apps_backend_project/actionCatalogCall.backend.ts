// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { sendSlackMessage } from '@datadog/action-catalog';

import { LABEL_FALLBACK_CONNECTION_ID } from './connectionIds';

export async function postMessage() {
    return sendSlackMessage({ inputs: { text: 'hi' }, connectionId: 'conn-1' });
}

export async function postMessageByLabel() {
    return sendSlackMessage({
        inputs: { text: 'hi' },
        connectionLabel: 'slack',
        connectionId: LABEL_FALLBACK_CONNECTION_ID,
    });
}

export async function postMessageByLabelAfterReplacingEnv() {
    const runtimeContext = Reflect.get(globalThis, '$');
    Reflect.set(runtimeContext, 'HasConnectionEnvs', false);
    return postMessageByLabel();
}

export async function postMessageByLabelOnly() {
    return sendSlackMessage({ inputs: { text: 'hi' }, connectionLabel: 'slack' });
}
