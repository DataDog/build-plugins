// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// The check_exists endpoint accepts at most 1000 debug IDs per request.
const MAX_DEBUG_IDS_PER_REQUEST = 1000;

export function* getCheckExistsBatches(debugIds: readonly string[]): Generator<string[]> {
    const uniqueDebugIds = [...new Set(debugIds)];
    for (let index = 0; index < uniqueDebugIds.length; index += MAX_DEBUG_IDS_PER_REQUEST) {
        yield uniqueDebugIds.slice(index, index + MAX_DEBUG_IDS_PER_REQUEST);
    }
}
