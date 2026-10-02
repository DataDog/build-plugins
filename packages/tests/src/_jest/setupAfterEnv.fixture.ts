// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { spawnSync } from 'child_process';

// Not named `*.test.*`: setupAfterEnv.test.ts spawns it in its own Jest process, because the
// variables have to be in the environment Jest starts with.
const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

const scrubbedKeys: unknown = Reflect.get(global, 'FIXTURE_SCRUBBED_KEYS');
if (!isStringArray(scrubbedKeys)) {
    throw new Error('The FIXTURE_SCRUBBED_KEYS global is required.');
}
const moduleScopeEnv = { ...process.env };

const childScript = 'process.stdout.write(JSON.stringify(Object.keys(process.env)))';
const child = spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });
if (child.status !== 0) {
    throw new Error(`Child process failed (${child.status}): ${child.error ?? child.stderr}`);
}
const childEnvNames: unknown = JSON.parse(child.stdout);
if (!isStringArray(childEnvNames)) {
    throw new Error(`Unexpected child output: ${child.stdout}`);
}

afterAll(() => {
    const exposedKeys = scrubbedKeys.filter((key) => process.env[key] !== undefined);
    const exposedList = exposedKeys.join(', ');
    if (exposedKeys.length) {
        throw new Error(`Exposed in teardown scope: ${exposedList}`);
    }
});

describe('Environment during test collection', () => {
    const describeScopeEnv = { ...process.env };
    const scopes = [
        { scope: 'module scope', isExposed: (key: string) => moduleScopeEnv[key] !== undefined },
        {
            scope: 'describe scope',
            isExposed: (key: string) => describeScopeEnv[key] !== undefined,
        },
        { scope: 'child processes', isExposed: (key: string) => childEnvNames.includes(key) },
    ];
    const cases = scrubbedKeys.flatMap((key) =>
        scopes.map(({ scope, isExposed }) => ({
            description: `hide ${key} from ${scope}`,
            key,
            isExposed,
        })),
    );

    test.each(cases)('Should $description', ({ key, isExposed }) => {
        const exposed = isExposed(key);
        expect(exposed).toBe(false);
    });
});
