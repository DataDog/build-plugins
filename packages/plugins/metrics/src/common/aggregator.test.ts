// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getLoaderMetrics,
    getPluginMetrics,
    getUniversalMetrics,
} from '@dd/metrics-plugin/common/aggregator';
import { getMockBuildReport } from '@dd/tests/_jest/helpers/mocks';

describe('Metrics Aggregator', () => {
    test('Should aggregate metrics without throwing.', () => {
        expect(() => {
            getUniversalMetrics(getMockBuildReport(), Date.now());
            getPluginMetrics(new Map(), Date.now());
            getLoaderMetrics(new Map(), Date.now());
        }).not.toThrow();
    });
});
