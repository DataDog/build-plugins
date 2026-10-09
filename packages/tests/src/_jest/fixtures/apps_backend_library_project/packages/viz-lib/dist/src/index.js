// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export async function loadSeries(query) {
    // Imports its own backend function by package specifier, as @datadog/apps-frontend does.
    const { fetchSeries } = await import('@fixtures/viz-lib/backend');
    return fetchSeries(query);
}
