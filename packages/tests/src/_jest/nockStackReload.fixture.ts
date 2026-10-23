// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Runs after setupAfterEnv's afterAll, which jest-circus calls first because it registered first.
afterAll(() => {
    const restoredNock = jest.requireActual<typeof import('nock')>('nock');
    if (restoredNock.isActive()) {
        throw new Error("Expected setupAfterEnv's afterAll to have restored its nock already.");
    }
    jest.resetModules();
    const reloadedNock = jest.requireActual<typeof import('nock')>('nock');
    if (reloadedNock === restoredNock || !reloadedNock.isActive()) {
        throw new Error('Expected a second, active copy of nock.');
    }
});

test('Should run with the nock setupAfterEnv loaded', () => {
    const setupNock = jest.requireActual<typeof import('nock')>('nock');
    const isSetupNockActive = setupNock.isActive();
    expect(isSetupNockActive).toBe(true);
});
