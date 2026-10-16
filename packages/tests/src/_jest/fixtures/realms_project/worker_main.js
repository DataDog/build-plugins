// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// realms_project/worker_main.js

// Only built by bundlers that emit `new Worker(new URL(...))` as a separate file.
// The tests run the emitted worker, never this entry.
export function startWorker() {
    return new Worker(new URL('./src/worker.js', import.meta.url));
}
