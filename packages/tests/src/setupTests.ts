// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import console from 'console';
import nock from 'nock';

import { toBeWithinRange } from './helpers/toBeWithinRange.ts';

// Extend Jest's expect with custom matchers.
expect.extend({
    toBeWithinRange,
});

declare module 'expect' {
    interface AsymmetricMatchers {
        toBeWithinRange(floor: number, ceiling: number): void;
    }

    // Do not send any HTTP requests.
    nock.disableNetConnect();

// Have a simpler, less verbose, console.log output.
global.console = console;
