// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMetrics } from '@dd/telemetry-plugins/common/aggregator';
import { mockReport, mockBundler, mockOptionsDD } from '@dd/tests/plugins/telemetry/testHelpers';

describe('Telemetry Aggregator', () => {
    test('It should aggregate metrics without throwing.', () => {
        expect(() => {
            getMetrics(mockOptionsDD, mockReport, mockBundler, '');
        }).not.toThrow();
    });
});
