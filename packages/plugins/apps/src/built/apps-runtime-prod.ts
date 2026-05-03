// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
import { postMessageTransport } from '../backend/client/transports/post-message-transport/post-message-transport';

const globalAny: any = globalThis;
globalAny.DD_APPS_RUNTIME = { executeBackendFunction: postMessageTransport };
