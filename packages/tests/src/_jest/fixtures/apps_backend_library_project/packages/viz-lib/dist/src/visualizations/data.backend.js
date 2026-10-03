// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { queryTimeseriesData } from '@datadog/action-catalog/dd/metrics';
// The package's own modules, reached both by relative path and by package specifier.
import { METRICS_CONNECTION_ID } from '@fixtures/viz-lib/connections';

import { toTimeseriesRequest } from './request.js';

export async function fetchSeries(query) {
    const series = await queryTimeseriesData({
        inputs: toTimeseriesRequest(query),
        connectionId: METRICS_CONNECTION_ID,
    });
    return { query, series, servedBy: 'viz-lib backend body' };
}
