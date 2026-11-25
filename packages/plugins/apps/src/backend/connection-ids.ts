// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeConnectionId(id: string): string {
    return UUID_PATTERN.test(id) ? id.toLowerCase() : id;
}

export function mergeAllowedConnectionIds(
    configuredIds: readonly string[] = [],
    discoveredIds: readonly string[] = [],
): string[] {
    const merged = new Set<string>();
    for (const list of [configuredIds, discoveredIds]) {
        for (const id of list) {
            const normalizedId = normalizeConnectionId(id);
            merged.add(normalizedId);
        }
    }
    return [...merged].sort();
}
