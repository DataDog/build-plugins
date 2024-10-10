// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const Sequencer = require('@jest/test-sequencer').default;

/** @typedef {Parameters<typeof Sequencer.prototype.sort>[0]} Tests */
/** @typedef {Tests[number]} Test */

/**
 * @param {Test} test
 * @returns {boolean}
 */
const isHeavyTest = (test) => {
    return test.path.endsWith('src/tools/src/rollupConfig.test.ts');
};

module.exports = class CustomSequencer extends Sequencer {
    /**
     * @param {Tests} tests
     * @returns {Promise<Tests>}
     */
    async sort(tests) {
        /** @type {Tests} */
        const sortedTests = [];

        // First, add the heavy tests.
        for (const test of tests) {
            if (isHeavyTest(test)) {
                sortedTests.push(test);
            }
        }

        // Then add the rest of the tests, using the default sort.
        const superSortedTests = await super.sort(tests.filter((test) => !isHeavyTest(test)));
        sortedTests.push(...superSortedTests);

        return sortedTests;
    }
};
