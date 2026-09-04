// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Side-effect-only import: installs env-guard.ts's process.env Proxy before this file's own
// describe blocks run, matching the exact precondition installFakeProcessEnv runs under in its
// real consumers (env-guard.test.ts, local-execution.test.ts both import env-guard.ts directly).
import '@dd/apps-plugin/vite/env-guard';
import { installFakeProcessEnv } from '@dd/tests/_jest/helpers/env';

// Set once, before any describe body's beforeAll swaps process.env — must survive round-tripping
// through installFakeProcessEnv's swap-and-restore for a later, sibling describe block to see it.
process.env.QA_RESTORE_MARKER = 'the-real-value-must-survive';

describe('installFakeProcessEnv — while the fake baseline is active', () => {
    installFakeProcessEnv({ PATH: '/usr/bin' });

    test('Should hide the real environment while the fake baseline is installed', () => {
        expect(process.env.QA_RESTORE_MARKER).toBeUndefined();
        expect(process.env.PATH).toBe('/usr/bin');
    });
});

describe('installFakeProcessEnv — after the fake baseline describe block finishes', () => {
    test('Should have restored the real environment value, not left it stranded at the fake baseline', () => {
        expect(process.env.QA_RESTORE_MARKER).toBe('the-real-value-must-survive');
    });
});

// Regression coverage: resetBetweenTests's afterEach used to reassign process.env back to the SAME
// baseline object every test received, instead of a fresh copy — a test mutating process.env
// mutated that shared object directly, so the "reset" just reinstalled the already-mutated state.
describe('installFakeProcessEnv — resetBetweenTests', () => {
    installFakeProcessEnv({ PATH: '/usr/bin' }, { resetBetweenTests: true });

    test('Should allow this test to mutate process.env', () => {
        process.env.MUTATED_BY_FIRST_TEST = 'leaks-into-the-next-test-if-baseline-itself-is-shared';
        expect(process.env.MUTATED_BY_FIRST_TEST).toBe(
            'leaks-into-the-next-test-if-baseline-itself-is-shared',
        );
    });

    test("Should start from a clean copy of the baseline, not carry over the previous test's mutation", () => {
        expect(process.env.MUTATED_BY_FIRST_TEST).toBeUndefined();
        expect(process.env.PATH).toBe('/usr/bin');
    });
});
