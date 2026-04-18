// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
import { executeBackendFunction } from '../backend-function-client/execute-backend-function';

// Exposed on `globalThis.DD_APPS_RUNTIME` by the apps plugin injection so
// generated proxy modules can call `executeBackendFunction` without importing
// a runtime package. Internal API — consumers (generated .backend.ts proxy
// modules) are produced by the apps plugin itself, not authored by users.
const globalAny: any = globalThis;
globalAny.DD_APPS_RUNTIME = { executeBackendFunction };
