// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */

import { runBenchPair } from './harness.js';
import { workloads } from './workload.js';

export function registerBenchVariant(variant) {
    if (!globalThis['ddBench']) {
        globalThis['ddBench'] = {};
    }

    globalThis['ddBench'][variant] = {
        runBenchPair,
        workloads,
        variant,
    };
}
