// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

let requestCounter = 0;

export function generateRequestId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    requestCounter += 1;
    // The runtime and the dev client each bundle this counter, so a random part keeps their ids apart.
    const randomPart = Math.random().toString(36).slice(2);
    return `req-${Date.now()}-${requestCounter}-${randomPart}`;
}
