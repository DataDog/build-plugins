// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

await new Promise((resolve) => setTimeout(resolve, 1200));

export async function runAfterSlowLoad(delayMs: number) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return 'done';
}
