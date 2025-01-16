// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createBrowserRouter } from '@datadog/browser-rum-react/react-router-v6';
import { reactPlugin } from '@datadog/browser-rum-react';

// To please TypeScript.
const globalAny: any = global;

// Have them globally available.
globalAny.reactPlugin = reactPlugin;
globalAny.createBrowserRouter = createBrowserRouter;

// Also them to the global DD_RUM object.
globalAny.DD_RUM = globalAny.DD_RUM || {};
globalAny.DD_RUM.reactPlugin = reactPlugin;
globalAny.DD_RUM.createBrowserRouter = createBrowserRouter;
