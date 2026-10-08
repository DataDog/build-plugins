// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    execFileSync: jest.fn(),
}));

type GlobalSetupModule = typeof import('./globalSetup');
type ChildProcessModule = typeof import('child_process');

const SECRET_NAME = 'GLOBAL_SETUP_TEST_SECRET';
const SECRET_VALUE = 'fake-secret';

describe('globalSetup', () => {
    let globalSetup: GlobalSetupModule['default'];
    let execFileSyncMock: jest.MockedFunction<ChildProcessModule['execFileSync']>;

    beforeEach(() => {
        // globalSetup keeps per-process state, so each test loads a fresh copy of it.
        jest.resetModules();
        globalSetup = jest.requireActual<GlobalSetupModule>('./globalSetup').default;
        const childProcess = jest.requireMock<ChildProcessModule>('child_process');
        execFileSyncMock = jest.mocked(childProcess.execFileSync);
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'time').mockImplementation(() => {});
        jest.spyOn(console, 'timeEnd').mockImplementation(() => {});
        process.env[SECRET_NAME] = SECRET_VALUE;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Records the secret's value in the env each fixture setup command receives.
    const captureSetupSecrets = () => {
        const secretsSeenBySetup: (string | undefined)[] = [];
        execFileSyncMock.mockImplementation((_file, _args, options) => {
            secretsSeenBySetup.push(options?.env?.[SECRET_NAME]);
            return '';
        });
        return secretsSeenBySetup;
    };

    test('Should scrub the env that test workers and child processes inherit', () => {
        globalSetup();

        expect(process.env[SECRET_NAME]).toBeUndefined();
        expect(process.env.PATH).toBeDefined();
    });

    test('Should scrub only after the fixture setup, which may need the full env', () => {
        const secretSeenBySetup = captureSetupSecrets();

        globalSetup();

        const setupAlwaysSawSecret = secretSeenBySetup.every((value) => value === SECRET_VALUE);
        expect(secretSeenBySetup.length).toBeGreaterThan(0);
        expect(setupAlwaysSawSecret).toBe(true);
        expect(process.env[SECRET_NAME]).toBeUndefined();
    });

    test("Should give fixture setup the first run's unscrubbed env on watch reruns", () => {
        globalSetup();
        const secretSeenByRerunSetup = captureSetupSecrets();
        globalSetup();

        const rerunSetupAlwaysSawSecret = secretSeenByRerunSetup.every(
            (value) => value === SECRET_VALUE,
        );
        expect(secretSeenByRerunSetup.length).toBeGreaterThan(0);
        expect(rerunSetupAlwaysSawSecret).toBe(true);
        expect(process.env[SECRET_NAME]).toBeUndefined();
    });
});
