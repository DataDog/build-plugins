// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { mockReport, mockStats } from '@datadog/build-plugins-tests/testHelpers';

describe('Aggregator', () => {
    test('It should aggregate metrics without throwing.', () => {
        const { getMetrics } = require('@dd/telemetry-plugins/common/aggregator');
        const opts = { context: '', filters: [], tags: [] };
        expect(() => {
            getMetrics(opts, mockReport, mockStats);
        }).not.toThrow();
    });
});
