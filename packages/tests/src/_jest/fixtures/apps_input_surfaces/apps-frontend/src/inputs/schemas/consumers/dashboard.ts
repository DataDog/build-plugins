// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createDatadogAppInputConsumer, withInputBuildMarker } from '../../published-definition';

export const datadogDashboard = /* @__PURE__ */ withInputBuildMarker(
    /* @__PURE__ */ createDatadogAppInputConsumer({
        identifier: 'datadog.dashboard',
        surfaces: ['datadog.dashboard', 'datadog.notebook'],
    }),
    'dd-app-input/v1 datadog.dashboard surfaces=datadog.dashboard,datadog.notebook',
);
