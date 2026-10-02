// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// setupAfterEnv loads this before every test file, so it must stay free of imports: anything it
// imported would be cached ahead of the test file's jest.mock() calls.

// Everything else is removed, including CI secrets and the DD_*/DATADOG_* overrides plugins read.
const ALLOWED_NAMES = new Set([
    // System basics that tools and child processes (git, node, esbuild) rely on.
    'HOME',
    'LANG',
    'LOGNAME',
    'PATH',
    'PWD',
    'SHELL',
    'TEMP',
    'TERM',
    'TMP',
    'TMPDIR',
    'TZ',
    'USER',
    // Node, CI detection, and color output.
    'CI',
    'COLORTERM',
    'FORCE_COLOR',
    'NO_COLOR',
    'NODE_ENV',
    'NODE_OPTIONS',
    // Debugging and coverage tooling.
    'DEBUG',
    'NODE_DEBUG',
    'NODE_EXTRA_CA_CERTS',
    'NODE_V8_COVERAGE',
    'TS_JEST_LOG',
    'VSCODE_INSPECTOR_OPTIONS',
    // dd-trace starts again in each Jest worker and tags its test events from these, plus the
    // DD_CIVISIBILITY_/DD_TEST_/DD_TRACE_ prefixes below. None of them is a credential.
    'DD_ENV',
    'DD_SERVICE',
    'DD_TAGS',
    'DD_VERSION',
    'GITHUB_ACTION',
    'GITHUB_ACTIONS',
    'GITHUB_BASE_REF',
    'GITHUB_EVENT_PATH',
    'GITHUB_HEAD_REF',
    'GITHUB_JOB',
    'GITHUB_REF',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_NUMBER',
    'GITHUB_SERVER_URL',
    'GITHUB_SHA',
    'GITHUB_WORKFLOW',
    'GITHUB_WORKSPACE',
    'JOB_CHECK_RUN_ID',
    'RUNNER_TEMP',
    // Set by yarn and the test:unit script.
    'BUILD_PLUGINS_ENV',
    'INIT_CWD',
    'PROJECT_CWD',
    'VITE_CJS_IGNORE_WARNING',
    // Test runner and build flags; JEST_* ones are covered by the prefix below.
    'NEED_BUILD',
    'NO_CLEANUP',
    'NO_TYPES',
    'REQUESTED_BUNDLERS',
]);
// Windows system variables that node, git, and other child processes need to start.
const ALLOWED_WINDOWS_NAMES = new Set([
    'APPDATA',
    'COMSPEC',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'PATHEXT',
    'PROGRAMDATA',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'USERPROFILE',
    'WINDIR',
]);
const ALLOWED_PREFIXES = ['DD_CIVISIBILITY_', 'DD_TEST_', 'DD_TRACE_', 'JEST_', 'LC_'];

export const isAllowedEnvName = (name: string, platform: string) => {
    // Windows env names are case-insensitive, and the search path is usually spelled `Path`.
    const isWindows = platform === 'win32';
    const comparableName = isWindows ? name.toUpperCase() : name;
    return (
        ALLOWED_NAMES.has(comparableName) ||
        (isWindows && ALLOWED_WINDOWS_NAMES.has(comparableName)) ||
        ALLOWED_PREFIXES.some((prefix) => comparableName.startsWith(prefix))
    );
};

export const scrubEnv = () => {
    const names = Object.keys(process.env);
    for (const name of names) {
        if (!isAllowedEnvName(name, process.platform)) {
            delete process.env[name];
        }
    }
};
