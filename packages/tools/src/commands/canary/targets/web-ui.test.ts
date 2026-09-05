// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { containsLinkReference, createWebUiPhase } from './web-ui';

describe('web-ui canary target', () => {
    test('should detect nested Yarn link and portal references', () => {
        expect(
            containsLinkReference({
                resolutions: {
                    package: 'link:/tmp/package',
                },
            }),
        ).toBe(true);
        expect(
            containsLinkReference({
                resolutions: ['portal:/tmp/package'],
            }),
        ).toBe(true);
        expect(
            containsLinkReference({
                resolutions: {
                    package: 'npm:1.0.0',
                },
            }),
        ).toBe(false);
    });

    test('should vary only Live Debugger enablement between paired builds', () => {
        const phase = createWebUiPhase('main');
        const control = phase.getBuildCommand('/web-ui', 'control');
        const instrumented = phase.getBuildCommand('/web-ui', 'instrumented');

        expect(control.env).toEqual({
            ...instrumented.env,
            BUILD_PLUGIN_LIVE_DEBUGGER: 'false',
        });
        expect(instrumented.env?.BUILD_PLUGIN_LIVE_DEBUGGER).toBe('true');
        expect(instrumented.env).not.toHaveProperty('BUILD_PLUGIN_LIVE_DEBUGGER_INCLUDE');
        expect(instrumented.env).not.toHaveProperty('BUILD_PLUGIN_LIVE_DEBUGGER_EXCLUDE');
    });

    test('should keep validation outside the timed build', () => {
        const phase = createWebUiPhase('main');
        const build = phase.getBuildCommand('/web-ui', 'control');
        const validation = phase.getValidationCommand('/web-ui', 'control');

        expect(build.args).toEqual(expect.arrayContaining(['--clean', '--no-validate']));
        expect(validation.args).toEqual(expect.arrayContaining(['--no-build', '--validate']));
    });

    test('should use the dynamic split-deploys preset for the federated phase', () => {
        const phase = createWebUiPhase('federated');
        const build = phase.getBuildCommand('/web-ui', 'instrumented');

        expect(build.args).toEqual(
            expect.arrayContaining(['--split-deploys', '--entry-preset=split-deploys']),
        );
    });
});
