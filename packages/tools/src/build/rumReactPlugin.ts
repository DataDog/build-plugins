// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createBrowserRouter } from '@datadog/browser-rum-react/react-router-v6';
import { reactPlugin } from '@datadog/browser-rum-react';

(() => {
    const globalAny: any = global;
    globalAny.reactPlugin = reactPlugin;
    globalAny.DD_RUM = globalAny.DD_RUM || {};
    globalAny.DD_RUM.createBrowserRouter = createBrowserRouter;
})();
