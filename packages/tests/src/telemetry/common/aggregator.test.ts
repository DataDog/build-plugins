// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    mockReport,
    mockBundler,
    mockOptionsWithTelemetryEnabled,
} from '@datadog/build-plugins-tests/testHelpers';
import { getMetrics } from '@dd/telemetry-plugins/common/aggregator';

describe('Aggregator', () => {
    test('It should aggregate metrics without throwing.', () => {
        expect(() => {
            getMetrics(mockOptionsWithTelemetryEnabled, mockReport, mockBundler);
        }).not.toThrow();
    });
});
