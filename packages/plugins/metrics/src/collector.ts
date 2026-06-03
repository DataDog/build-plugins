// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, GlobalStores } from '@dd/core/types';

export const initializeMetricsCollector = (context: GlobalContext, stores: GlobalStores) => {
    context.addMetric = (metric) => {
        stores.metrics.add(metric);
    };
};
