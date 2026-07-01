// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Live Debugger plugin options shared by the benchmark build (run through the
// bundler harness in liveDebuggerRuntime.bench.ts) and the CI preflight build
// (run through Rspack directly in preflight-build.js). Sharing the object is
// what keeps the preflight's "did the instrumented output change" hash gated on
// the same instrumentation the benchmark actually measures.

/**
 * @param {boolean} enable
 */
const getLiveDebuggerBenchConfig = (enable) => {
    return {
        enable,
        include: [/workload\.js$/],
        namedOnly: true,
    };
};

module.exports = { getLiveDebuggerBenchConfig };
