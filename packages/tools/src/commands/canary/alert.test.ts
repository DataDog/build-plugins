// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatCheckoutAlert, formatRunAlert } from './alert';
import type { CanaryReport, FailureKind } from './types';

const createReport = (overrides: Partial<CanaryReport>): CanaryReport => {
    return {
        schemaVersion: 3,
        status: 'failed',
        failureKind: 'plugin',
        target: 'excalidraw',
        phaseSelection: 'app',
        runId: '12345',
        startedAt: '2026-10-21T04:00:00.000Z',
        generatedAt: '2026-10-21T04:05:00.000Z',
        reportPath: '/tmp/report.json',
        environment: { node: 'v24.22.0', platform: 'linux', arch: 'x64' },
        repositories: {
            buildPlugins: { root: '/builds/build-plugins', commit: '3a13adb9f00d', dirty: false },
            target: { root: '/builds/canary-target', commit: 'e1b7aacb3560', dirty: false },
        },
        phases: [],
        failures: [
            {
                message: 'app all-functions build failed with exit code 1.',
                stage: 'phase:app:all-functions:build',
            },
        ],
        ...overrides,
    };
};

const LINKS = {
    job: 'https://gitlab.example/jobs/1',
    pipeline: 'https://gitlab.example/pipelines/2',
};

describe('canary alerts', () => {
    test('should describe a plugin failure with its stage, commits and links', () => {
        const report = createReport({});

        const message = formatRunAlert(report, LINKS);

        const expected = [
            ':red_circle: *Live Debugger build canary failed*: `excalidraw`, phase `app`',
            '*Kind:* plugin: the control build passed but an instrumented build failed, so Live Debugger is the suspect.',
            '*Stage:* `phase:app:all-functions:build`',
            '*Error:* app all-functions build failed with exit code 1.',
            '*Commits:* build-plugins `3a13adb9`, excalidraw `e1b7aacb`',
            '<https://gitlab.example/jobs/1|Job log and artifacts> · <https://gitlab.example/pipelines/2|Pipeline>',
            '',
        ].join('\n');
        expect(message).toBe(expected);
    });

    const kindCases: { description: string; failureKind: FailureKind; expected: string }[] = [
        {
            description: 'explain a target failure',
            failureKind: 'target',
            expected:
                "*Kind:* target: the target, its setup or its control build failed, so Live Debugger wasn't evaluated.",
        },
        {
            description: 'explain an interrupted run',
            failureKind: 'interrupted',
            expected: '*Kind:* interrupted: the run was stopped before it finished.',
        },
    ];

    test.each(kindCases)('should $description', ({ failureKind, expected }) => {
        const report = createReport({ failureKind });

        const message = formatRunAlert(report, LINKS);

        expect(message).toContain(expected);
    });

    test('should leave out links outside of CI', () => {
        const report = createReport({});

        const message = formatRunAlert(report, { job: undefined, pipeline: undefined });

        expect(message).not.toContain('<');
    });

    test('should describe a checkout failure', () => {
        const message = formatCheckoutAlert({
            links: LINKS,
            message: 'fetch ddoghq/web-ui preprod failed with exit code 128.',
            ref: 'preprod',
            repository: 'ddoghq/web-ui',
            target: 'web-ui',
        });

        expect(message).toContain(':red_circle: *Live Debugger build canary failed*: `web-ui`');
        expect(message).toContain(
            '*Kind:* target: checking out ddoghq/web-ui preprod or resolving its toolchain failed, so nothing was built.',
        );
        expect(message).toContain(
            '*Error:* fetch ddoghq/web-ui preprod failed with exit code 128.',
        );
    });
});
