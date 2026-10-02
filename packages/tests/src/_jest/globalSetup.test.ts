// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { execFileSync } from 'child_process';

import globalSetup from './globalSetup';

jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    execFileSync: jest.fn(),
}));

const execFileSyncMock = jest.mocked(execFileSync);
const SECRET_NAME = 'GLOBAL_SETUP_TEST_SECRET';

describe('globalSetup', () => {
    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'time').mockImplementation(() => {});
        jest.spyOn(console, 'timeEnd').mockImplementation(() => {});
        process.env[SECRET_NAME] = 'fake-secret';
    });

    afterEach(() => {
        jest.restoreAllMocks();
        execFileSyncMock.mockReset();
    });

    test('Should scrub the env that test workers and child processes inherit', () => {
        globalSetup();

        expect(process.env[SECRET_NAME]).toBeUndefined();
        expect(process.env.PATH).toBeDefined();
    });

    test('Should scrub only after the fixture setup, which may need the full env', () => {
        const secretSeenBySetup: boolean[] = [];
        execFileSyncMock.mockImplementation(() => {
            secretSeenBySetup.push(SECRET_NAME in process.env);
            return '';
        });

        globalSetup();

        const setupAlwaysSawSecret = secretSeenBySetup.every(Boolean);
        expect(secretSeenBySetup.length).toBeGreaterThan(0);
        expect(setupAlwaysSawSecret).toBe(true);
        expect(process.env[SECRET_NAME]).toBeUndefined();
    });
});
