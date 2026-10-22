// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */
import { prepareCall } from '../backend/client/dev-client/dev-client';
import { DEV_CLIENT_HOOK } from '../backend/protocol';

Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);
