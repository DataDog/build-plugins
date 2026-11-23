// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// version_stability_project/lazy.js

import { shared } from './shared.js';

export const lazy = () => `LAZY_WITH_SHARED_IMPORT ${shared()}`;
