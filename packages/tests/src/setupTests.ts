// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import nock from 'nock';

import { toBeWithinRange } from './helpers/toBeWithinRange.ts';

expect.extend({
    toBeWithinRange,
});

declare module 'expect' {
    interface AsymmetricMatchers {
        toBeWithinRange(floor: number, ceiling: number): void;
    }
    interface Matchers<R> {
        toBeWithinRange(floor: number, ceiling: number): R;
    }
}

global.beforeAll(() => {
    // Do not send any HTTP requests.
    nock.disableNetConnect();
});