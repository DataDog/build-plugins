// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type BackendRuntime = 'v1' | 'v2';

const RUNTIME_LABELS: Record<BackendRuntime, string> = {
    v1: 'Deno',
    v2: 'Node',
};

export function describeRuntime(runtime: BackendRuntime): string {
    return `${RUNTIME_LABELS[runtime]} backend runtime (${runtime})`;
}

export const RUNTIME_FALLBACK_NOTE =
    "the org's backend runtime couldn't be determined, so the stricter v1 checks apply";
