// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// circular_project/src/registry.js

import { withFallback } from './columns.js';

export const registry = { width: withFallback(undefined, 120) };
