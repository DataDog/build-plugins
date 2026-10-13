// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createDatadogAppInputConsumer, withInputBuildMarker } from '../../published-definition';

export const datadogServicePanel = /* @__PURE__ */ withInputBuildMarker(
    /* @__PURE__ */ createDatadogAppInputConsumer({
        identifier: 'datadog.service-panel',
        surfaces: ['datadog.idp.service-panel'],
    }),
    'dd-app-input/v1 datadog.service-panel surfaces=datadog.idp.service-panel',
);
