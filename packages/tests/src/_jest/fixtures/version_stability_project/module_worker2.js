// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// version_stability_project/module_worker2.js

import { doubleInModuleWorker } from './module_worker_shared.js';

globalThis.moduleWorker2Result = doubleInModuleWorker(21);
