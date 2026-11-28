// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const INJECTED_FILE = '__datadog-helper-file';
export const INJECTED_FILE_RX = new RegExp(INJECTED_FILE);

export const ALL_ENVS = ['development', 'production', 'test'] as const;
export const ALL_BUNDLERS = ['webpack', 'vite', 'esbuild', 'rollup', 'rspack', 'rolldown', 'farm'];
export const SUPPORTED_BUNDLERS = ['webpack', 'vite', 'esbuild', 'rollup', 'rspack'] as const;

// source of truth: site parameter column of the site list in
// https://docs.datadoghq.com/getting_started/site/
export const SITES = [
    'datadoghq.com',
    'us3.datadoghq.com',
    'us5.datadoghq.com',
    'datadoghq.eu',
    'ddog-gov.com',
    'us2.ddog-gov.com',
    'ap1.datadoghq.com',
    'ap2.datadoghq.com',
    'uk1.datadoghq.com',
    'datad0g.com',
] as const;

export const DEFAULT_SITE = SITES[0];

export const ENV_VAR_REQUESTED_BUNDLERS = 'PLAYWRIGHT_REQUESTED_BUNDLERS';

export const HOST_NAME = 'datadog-build-plugins';

// Global function that Live Debugger instrumentation calls at the start of
// every instrumented function, with the function's ID as its only argument.
// It replaced `$dd_probes` when the exit hooks stopped receiving `this` and the
// arguments, so a Browser Debugger SDK that only defines `$dd_probes` leaves
// newer builds dormant instead of calling their hooks the old way.
export const LIVE_DEBUGGER_PROBES_FUNCTION = '$dd_probes2';

// Global function that Live Debugger instrumentation calls, when Exception
// Replay is enabled, for every exception that leaves an instrumented function,
// with the function's ID as its first argument and the invocation handle as
// its last.
export const LIVE_DEBUGGER_CATCH_FUNCTION = '$dd_catch';
