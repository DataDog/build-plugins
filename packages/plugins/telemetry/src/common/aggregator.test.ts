// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { addMetrics } from '@dd/telemetry-plugin/common/aggregator';
import { getContextMock, mockOptionsDD, mockReport } from '@dd/tests/_jest/helpers/mocks';

describe('Telemetry Aggregator', () => {
    test('Should aggregate metrics without throwing.', () => {
        expect(() => {
            addMetrics(getContextMock(), mockOptionsDD, new Set(), mockReport);
        }).not.toThrow();
    });
});
