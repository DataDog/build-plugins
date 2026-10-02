// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export function mergeAllowedConnectionIds(
    configuredIds: readonly string[] = [],
    discoveredIds: readonly string[] = [],
): string[] {
    const merged = new Set(configuredIds);
    for (const id of discoveredIds) {
        merged.add(id);
    }
    return [...merged].sort();
}
