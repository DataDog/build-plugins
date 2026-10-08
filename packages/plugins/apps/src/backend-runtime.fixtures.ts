// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BackendRuntimeStatus } from './backend-runtime';

export const V1_RUNTIME: BackendRuntimeStatus = { runtime: 'v1', isFallback: false };
export const V2_RUNTIME: BackendRuntimeStatus = { runtime: 'v2', isFallback: false };
export const V1_FALLBACK_RUNTIME: BackendRuntimeStatus = { runtime: 'v1', isFallback: true };
