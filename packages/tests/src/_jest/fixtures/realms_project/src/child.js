// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// realms_project/src/child.js

// Entry of the bundles built by another compiler than the instrumented one.
function doubleInChild(input) {
    return input * 2;
}

globalThis.realmsResult = doubleInChild(21);
