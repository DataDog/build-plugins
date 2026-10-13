// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// An extra --setupFilesAfterEnv for nockInterceptors.test.ts's positive control: it re-activates
// nock after setupAfterEnv.ts's afterAll restores it, so the next file stacks on this one.
afterAll(() => {
    const nock = jest.requireActual('nock');
    nock.activate();
});
