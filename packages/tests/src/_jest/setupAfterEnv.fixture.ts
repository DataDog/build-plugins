// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Not named `*.test.*`: setupAfterEnv.test.ts spawns it in its own Jest process, because the
// variables have to be in the environment Jest starts with.
if (!process.env.FIXTURE_SCRUBBED_KEYS) {
    throw new Error('FIXTURE_SCRUBBED_KEYS is required.');
}
const scrubbedKeys = process.env.FIXTURE_SCRUBBED_KEYS.split(',');
const moduleScopeEnv = { ...process.env };

afterAll(() => {
    const exposedKeys = scrubbedKeys.filter((key) => process.env[key] !== undefined);
    const exposedList = exposedKeys.join(', ');
    if (exposedKeys.length) {
        throw new Error(`Exposed in teardown scope: ${exposedList}`);
    }
});

describe('Environment during test collection', () => {
    const describeScopeEnv = { ...process.env };
    const cases = scrubbedKeys.flatMap((key) => [
        { description: `hide ${key} from module scope`, env: moduleScopeEnv, key },
        { description: `hide ${key} from describe scope`, env: describeScopeEnv, key },
    ]);

    test.each(cases)('Should $description', ({ env, key }) => {
        expect(env[key]).toBeUndefined();
    });
});
