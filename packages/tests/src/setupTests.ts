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
