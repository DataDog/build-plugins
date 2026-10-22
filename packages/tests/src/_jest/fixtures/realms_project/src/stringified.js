// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// realms_project/src/stringified.js

// A function whose source is run in another global scope, like an inline worker
// built from `fn.toString()`. It is compiled with the rest of the bundle.
export function doubleElsewhere(input) {
    return input * 2;
}

export const stringifiedSource = `(${doubleElsewhere.toString()})(21)`;
