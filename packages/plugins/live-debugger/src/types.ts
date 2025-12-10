// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type LiveDebuggerOptions = {
    enable?: boolean;
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
    skipHotFunctions?: boolean; // Honor @dd-no-instrumentation comments
};

export type LiveDebuggerOptionsWithDefaults = {
    enable: boolean;
    include: (string | RegExp)[];
    exclude: (string | RegExp)[];
    skipHotFunctions: boolean;
};
