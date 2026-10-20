// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// realms_project/src/worker.js

function doubleInWorker(input) {
    return input * 2;
}

globalThis.realmsResult = doubleInWorker(21);
