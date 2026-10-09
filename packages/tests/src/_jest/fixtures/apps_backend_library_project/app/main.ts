// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { loadSeries } from '@fixtures/viz-lib';
import { describeOrdinary } from 'plain-backend-lib';

export const main = async () => {
    console.log(describeOrdinary());
    return loadSeries('avg:system.cpu.user{*}');
};

void main();
