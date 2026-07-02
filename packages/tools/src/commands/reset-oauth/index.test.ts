// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getDatadogOAuthConfig,
    readOAuthTokenFromKeychain,
    writeOAuthTokenToKeychain,
} from '@dd/core/helpers/oauth-request';
import commands from '@dd/tools/commands/reset-oauth/index';
import { Cli } from 'clipanion';
import { Writable } from 'stream';

// Marker that makes the mocked keychain reject a delete, to exercise the
// command's error-collection branch.
const FORCE_DELETE_ERROR = 'FORCE_DELETE_ERROR';

const mockKeyringStore = new Map<string, string>();

jest.mock('@napi-rs/keyring', () => ({
    AsyncEntry: class {
        private readonly key: string;

        constructor(service: string, username: string) {
            this.key = `${service}:${username}`;
        }

        async deletePassword() {
            const stored = mockKeyringStore.get(this.key);
            if (stored && stored.includes(FORCE_DELETE_ERROR)) {
                throw new Error('Simulated keychain failure.');
            }
            mockKeyringStore.delete(this.key);
        }

        async getPassword() {
            return mockKeyringStore.get(this.key);
        }

        async setPassword(password: string) {
            mockKeyringStore.set(this.key, password);
        }
    },
}));

const seedToken = async (site: string, accessToken = `token-${site}`) => {
    const options = getDatadogOAuthConfig(site);
    await writeOAuthTokenToKeychain(
        site,
        { accessToken, clientId: options.clientId, site },
        options,
    );
};

const hasToken = async (site: string) => {
    const token = await readOAuthTokenFromKeychain(site, getDatadogOAuthConfig(site));
    return token !== undefined;
};

describe('Command reset-oauth', () => {
    const cli = new Cli();
    cli.register(commands[0]);

    // Discard clipanion's own output (it writes the thrown-error report to
    // stdout) to keep the test logs clean.
    const discard = new Writable({
        write(chunk, encoding, callback) {
            callback();
        },
    });
    const context = { ...Cli.defaultContext, stdout: discard, stderr: discard };
    const run = (args: string[]) => cli.run(args, context);

    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        mockKeyringStore.clear();
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('Should clear the token for every site by default.', async () => {
        await seedToken('datadoghq.com');
        await seedToken('datadoghq.eu');

        const exitCode = await run(['reset-oauth']);

        expect(exitCode).toBe(0);
        expect(await hasToken('datadoghq.com')).toBe(false);
        expect(await hasToken('datadoghq.eu')).toBe(false);
    });

    test('Should only clear the token for the targeted site.', async () => {
        await seedToken('datadoghq.com');
        await seedToken('datadoghq.eu');

        const exitCode = await run(['reset-oauth', '--site', 'datadoghq.eu']);

        expect(exitCode).toBe(0);
        expect(await hasToken('datadoghq.eu')).toBe(false);
        expect(await hasToken('datadoghq.com')).toBe(true);
    });

    test('Should reject an unknown site without touching stored tokens.', async () => {
        await seedToken('datadoghq.com');

        const exitCode = await run(['reset-oauth', '--site', 'nope.com']);

        expect(exitCode).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown site "nope.com"'));
        expect(await hasToken('datadoghq.com')).toBe(true);
    });

    test('Should succeed when no token is cached.', async () => {
        const exitCode = await run(['reset-oauth', '--site', 'datadoghq.com']);

        expect(exitCode).toBe(0);
    });

    test('Should report a non-zero exit code when a token cannot be cleared.', async () => {
        await seedToken('datadoghq.com', FORCE_DELETE_ERROR);

        const exitCode = await run(['reset-oauth', '--site', 'datadoghq.com']);

        expect(exitCode).toBe(1);
    });
});
