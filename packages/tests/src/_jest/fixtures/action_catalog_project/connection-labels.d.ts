// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export declare const CONNECTIONS_CONTEXT_KEY: string;
export declare const HAS_CONNECTION_ENVS_CONTEXT_KEY: string;
export declare const CONNECTION_LABEL_PATTERN: RegExp;

export interface ResolvedConnections {
    hasConnectionEnvs: boolean;
    connections: Record<string, unknown>;
}

export declare function readResolvedConnections(runtimeContext: unknown): ResolvedConnections;
export declare function swapConnectionLabel(
    request: unknown,
    resolved: ResolvedConnections,
): unknown;
export declare function getResolvedConnectionIds(
    runtimeContext: unknown,
    labels: string[],
): string[];
