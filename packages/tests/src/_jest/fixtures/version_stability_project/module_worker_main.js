// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// version_stability_project/module_worker_main.js

export function startWorkers() {
    return [
        new Worker(new URL('./module_worker.js', import.meta.url), { type: 'module' }),
        new Worker(new URL('./module_worker2.js', import.meta.url), { type: 'module' }),
    ];
}
