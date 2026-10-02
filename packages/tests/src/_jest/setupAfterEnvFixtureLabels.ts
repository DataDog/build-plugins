// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// setupAfterEnv.fixture.ts reports exposures with these labels and setupAfterEnv.test.ts parses
// them, so both read them from here.
export const MODULE_SCOPE = 'module scope';
export const DESCRIBE_SCOPE = 'describe scope';
export const CHILD_PROCESSES_SCOPE = 'child processes';
export const TEARDOWN_SCOPE = 'teardown scope';
export const ALL_SCOPES = [MODULE_SCOPE, DESCRIBE_SCOPE, CHILD_PROCESSES_SCOPE, TEARDOWN_SCOPE];
export const EXPOSURE_TEST_TITLE_PREFIX = 'Should hide ';
export const PROCESS_ID_TEST_TITLE_PREFIX = 'Should run in process ';
export const TEARDOWN_EXPOSURE_PREFIX = `Exposed in ${TEARDOWN_SCOPE}: `;

export const getExposureLabel = (name: string, scope: string) => `${name} from ${scope}`;
