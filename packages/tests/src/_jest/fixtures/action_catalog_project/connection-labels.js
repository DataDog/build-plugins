// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Stands in for the published helper's behavior, so the plugin's tests don't need its release.

export const CONNECTIONS_CONTEXT_KEY = 'Connections';
export const HAS_CONNECTION_ENVS_CONTEXT_KEY = 'HasConnectionEnvs';
export const CONNECTION_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function readResolvedConnections(runtimeContext) {
    const context = typeof runtimeContext === 'object' && runtimeContext !== null ? runtimeContext : {};
    const hasConnectionEnvs = context[HAS_CONNECTION_ENVS_CONTEXT_KEY] === true;
    const connectionsValue = hasConnectionEnvs ? context[CONNECTIONS_CONTEXT_KEY] : undefined;
    const connections = Object.create(null);
    if (typeof connectionsValue === 'object' && connectionsValue !== null) {
        Object.assign(connections, connectionsValue);
    }
    return { hasConnectionEnvs, connections };
}

export function swapConnectionLabel(request, resolved) {
    if (typeof request !== 'object' || request === null || !('connectionLabel' in request)) {
        return request;
    }
    const { connectionLabel, ...rest } = request;
    const label = String(connectionLabel);
    if (resolved.hasConnectionEnvs) {
        const connectionId = resolved.connections[label];
        if (typeof connectionId !== 'string') {
            throw new Error(
                `Connection label "${label}" is not mapped in this connection environment`,
            );
        }
        return { ...rest, connectionId };
    }
    if (typeof rest.connectionId !== 'string') {
        throw new Error(
            `Connection label "${label}" has no fallback connectionId and the app has no connection environment config`,
        );
    }
    return rest;
}

export function getResolvedConnectionIds(runtimeContext, labels) {
    const { connections } = readResolvedConnections(runtimeContext);
    const connectionIds = labels
        .map((label) => connections[label])
        .filter((value) => typeof value === 'string');
    return [...new Set(connectionIds)];
}
