// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
import { devServerTransport } from '../backend/client/transports/dev-server-transport';

const globalAny: any = globalThis;
globalAny.DD_APPS_RUNTIME = { executeBackendFunction: devServerTransport };
