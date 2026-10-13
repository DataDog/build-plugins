// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createDatadogAppInputConsumer, withInputBuildMarker } from '../../published-definition';

// Declares no surfaces: offered on every surface, so it implies no surface tag.
export const datadogTheme = /* @__PURE__ */ withInputBuildMarker(
    /* @__PURE__ */ createDatadogAppInputConsumer({ identifier: 'datadog.theme', surfaces: [] }),
    'dd-app-input/v1 datadog.theme surfaces=',
);
