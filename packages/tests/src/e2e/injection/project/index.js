// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */

// Stable line for sourcemap verification — do not move.
window.throwForSourcemap = function throwForSourcemap() {
    throw new Error('sourcemap_test');
};
