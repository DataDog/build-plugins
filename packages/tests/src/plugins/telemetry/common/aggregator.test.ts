// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMetrics } from '@dd/telemetry-plugin/common/aggregator';
import { getContextMock } from '@dd/tests/_jest/helpers/mocks';
import { mockOptionsDD, mockReport } from '@dd/tests/plugins/telemetry/testHelpers';

describe('Telemetry Aggregator', () => {
    test('Should aggregate metrics without throwing.', () => {
        expect(() => {
            getMetrics(getContextMock(), mockOptionsDD, mockReport);
        }).not.toThrow();
    });
});
