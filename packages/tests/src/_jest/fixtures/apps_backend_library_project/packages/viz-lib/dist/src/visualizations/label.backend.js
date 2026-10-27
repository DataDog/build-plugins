// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// A backend function file of its own that data.backend.js also imports: backend code gets its
// real body, never the frontend proxy.
export function labelSeries() {
    return 'viz-lib sibling backend body';
}
