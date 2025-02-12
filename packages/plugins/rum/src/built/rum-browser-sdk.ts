// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { datadogRum } from '@datadog/browser-rum';

// To please TypeScript.
const globalAny: any = globalThis;

// Also them to the global DD_RUM object.
globalAny.DD_RUM = datadogRum;
