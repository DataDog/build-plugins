// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    authorizeWithPKCE,
    buildAuthorizationUrl,
    deleteOAuthTokenFromKeychain,
    exchangeAuthorizationCode,
    getOAuthToken,
    readOAuthTokenFromKeychain,
    validateOAuthCallback,
    writeOAuthTokenToKeychain,
} from '@dd/apps-plugin/oauth';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';
import stripAnsi from 'strip-ansi';

const mockKeyringStore = new Map<string, string>();

jest.mock('oauth4webapi', () => {
    const postTokenRequest = (url: string, body: Record<string, string>): Promise<Response> => {
        return fetch(url, {
            body: new URLSearchParams(body).toString(),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            method: 'POST',
        });
    };

    const processTokenResponse = async (response: Response) => {
        const token = (await response.json()) as Record<string, unknown>;
        if (typeof token.token_type === 'string') {
            return { ...token, token_type: token.token_type.toLowerCase() };
        }

        return token;
    };

    return {
        None: () => undefined,
        authorizationCodeGrantRequest: (
            authorizationServer: { token_endpoint: string },
            client: { client_id: string },
            _clientAuth: unknown,
            callbackParameters: URLSearchParams,
            redirectUri: string,
            codeVerifier: string,
        ) =>
            postTokenRequest(authorizationServer.token_endpoint, {
                client_id: client.client_id,
                code: callbackParameters.get('code') || '',
                code_verifier: codeVerifier,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
            }),
        calculatePKCECodeChallenge: async (codeVerifier: string) => `challenge-${codeVerifier}`,
        processAuthorizationCodeResponse: (
            _authorizationServer: unknown,
            _client: unknown,
            response: Response,
        ) => processTokenResponse(response),
        processRefreshTokenResponse: (
            _authorizationServer: unknown,
            _client: unknown,
            response: Response,
        ) => processTokenResponse(response),
        refreshTokenGrantRequest: (
            authorizationServer: { token_endpoint: string },
            client: { client_id: string },
            _clientAuth: unknown,
            refreshToken: string,
        ) =>
            postTokenRequest(authorizationServer.token_endpoint, {
                client_id: client.client_id,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        validateAuthResponse: (
            _authorizationServer: unknown,
            _client: unknown,
            callbackUrl: URL,
            expectedState: string,
        ) => {
            if (callbackUrl.searchParams.get('state') !== expectedState) {
                throw new Error('Invalid OAuth state.');
            }

            return callbackUrl.searchParams;
        },
    };
});

jest.mock('@napi-rs/keyring', () => ({
    AsyncEntry: class {
        private readonly key: string;

        constructor(service: string, username: string) {
            this.key = `${service}:${username}`;
        }

        async deletePassword() {
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

const getAuthorizationUrlFromLog = (message: string) => {
    const match = stripAnsi(message).match(/https:\/\/\S+/);
    if (!match) {
        throw new Error(`Expected authorization URL in log message: ${message}`);
    }

    return new URL(match[0]);
};

const createAuthorizationUrlLogger = () => {
    let resolveUrl: (url: URL) => void = () => {};
    let rejectUrl: (error: unknown) => void = () => {};
    const url = new Promise<URL>((resolve, reject) => {
        resolveUrl = resolve;
        rejectUrl = reject;
    });

    const info = jest.fn((message: string) => {
        try {
            resolveUrl(getAuthorizationUrlFromLog(message));
        } catch (error) {
            rejectUrl(error);
        }
    });

    return { info, reject: rejectUrl, url };
};

const normalizeFormBody = (body: unknown) => {
    if (typeof body === 'string') {
        return Object.fromEntries(new URLSearchParams(body));
    }

    return body;
};

const createOAuthOptions = () => ({
    cacheTokens: true,
    clientId: 'client-id',
    openBrowser: false,
    redirectUri: 'http://localhost:8060',
    timeoutMs: 1000,
});

describe('Apps Plugin - OAuth', () => {
    beforeEach(() => {
        mockKeyringStore.clear();
    });

    afterEach(() => {
        nock.cleanAll();
        nock.disableNetConnect();
    });

    test('Should build Datadog OAuth authorization URL with PKCE parameters', () => {
        const url = buildAuthorizationUrl({
            clientId: 'client-id',
            codeChallenge: 'challenge',
            redirectUri: 'http://localhost:8060',
            site: 'datadoghq.com',
            state: 'state',
        });

        expect(url.toString()).toBe(
            'https://app.datadoghq.com/oauth2/v1/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8060&client_id=client-id&response_type=code&code_challenge=challenge&code_challenge_method=S256&state=state',
        );
    });

    test('Should exchange authorization code for token', async () => {
        const bodies: unknown[] = [];
        const scope = nock('https://api.datadoghq.com')
            .post('/oauth2/v1/token', (body) => {
                bodies.push(body);
                return true;
            })
            .reply(200, {
                access_token: 'access-token',
                expires_in: 3600,
                refresh_token: 'refresh-token',
                token_type: 'Bearer',
            });

        const token = await exchangeAuthorizationCode({
            callbackParameters: await validateOAuthCallback(
                'datadoghq.com',
                createOAuthOptions(),
                new URL('http://localhost:8060?code=code&state=state'),
                'state',
            ),
            clientId: 'client-id',
            codeVerifier: 'verifier',
            redirectUri: 'http://localhost:8060',
            site: 'datadoghq.com',
        });

        expect(scope.isDone()).toBe(true);
        expect(normalizeFormBody(bodies[0])).toEqual({
            client_id: 'client-id',
            code: 'code',
            code_verifier: 'verifier',
            grant_type: 'authorization_code',
            redirect_uri: 'http://localhost:8060',
        });
        expect(token).toEqual(
            expect.objectContaining({
                accessToken: 'access-token',
                expiresIn: 3600,
                refreshToken: 'refresh-token',
                site: 'datadoghq.com',
                tokenType: 'bearer',
            }),
        );
        expect(token.expiresAt).toEqual(expect.any(Number));
    });

    test('Should use cached access token when it is still valid', async () => {
        await writeOAuthTokenToKeychain(
            'datadoghq.com',
            {
                accessToken: 'cached-token',
                clientId: 'client-id',
                expiresAt: Date.now() + 60 * 60 * 1000,
                refreshToken: 'refresh-token',
                site: 'datadoghq.com',
                tokenType: 'bearer',
            },
            createOAuthOptions(),
        );

        const token = await getOAuthToken('datadoghq.com', createOAuthOptions(), getMockLogger());

        expect(token).toEqual({
            accessToken: 'cached-token',
            expiresAt: expect.any(Number),
            refreshToken: 'refresh-token',
            site: 'datadoghq.com',
            tokenType: 'bearer',
        });
    });

    test('Should refresh cached token when it is expired', async () => {
        const bodies: unknown[] = [];
        await writeOAuthTokenToKeychain(
            'datadoghq.com',
            {
                accessToken: 'expired-token',
                clientId: 'client-id',
                expiresAt: Date.now() - 1000,
                refreshToken: 'old-refresh-token',
                site: 'datadoghq.com',
                tokenType: 'bearer',
            },
            createOAuthOptions(),
        );
        const scope = nock('https://api.datadoghq.com')
            .post('/oauth2/v1/token', (body) => {
                bodies.push(body);
                return true;
            })
            .reply(200, {
                access_token: 'refreshed-token',
                expires_in: 3600,
                token_type: 'Bearer',
            });

        const token = await getOAuthToken('datadoghq.com', createOAuthOptions(), getMockLogger());
        const cachedToken = await readOAuthTokenFromKeychain('datadoghq.com', createOAuthOptions());

        expect(scope.isDone()).toBe(true);
        expect(normalizeFormBody(bodies[0])).toEqual({
            client_id: 'client-id',
            grant_type: 'refresh_token',
            refresh_token: 'old-refresh-token',
        });
        expect(token).toEqual(
            expect.objectContaining({
                accessToken: 'refreshed-token',
                refreshToken: 'old-refresh-token',
                site: 'datadoghq.com',
                tokenType: 'bearer',
            }),
        );
        expect(cachedToken).toEqual(
            expect.objectContaining({
                accessToken: 'refreshed-token',
                refreshToken: 'old-refresh-token',
            }),
        );
    });

    test('Should store tokens in the OS credential store', async () => {
        await writeOAuthTokenToKeychain(
            'datadoghq.com',
            {
                accessToken: 'cached-token',
                clientId: 'client-id',
                site: 'datadoghq.com',
            },
            createOAuthOptions(),
        );

        await expect(
            readOAuthTokenFromKeychain('datadoghq.com', createOAuthOptions()),
        ).resolves.toEqual({
            accessToken: 'cached-token',
            clientId: 'client-id',
            site: 'datadoghq.com',
        });

        await deleteOAuthTokenFromKeychain('datadoghq.com', createOAuthOptions());
        await expect(
            readOAuthTokenFromKeychain('datadoghq.com', createOAuthOptions()),
        ).resolves.toBeUndefined();
    });

    test('Should authorize with PKCE using a local callback', async () => {
        const port = 18060;
        const redirectUri = `http://127.0.0.1:${port}`;
        const authorizationUrlLogger = createAuthorizationUrlLogger();
        const logger = getMockLogger({ info: authorizationUrlLogger.info });
        nock.enableNetConnect('127.0.0.1');
        const scope = nock('https://api.datadoghq.com')
            .post('/oauth2/v1/token')
            .reply(200, { access_token: 'access-token', token_type: 'Bearer' });

        const tokenPromise = authorizeWithPKCE(
            'datadoghq.com',
            {
                cacheTokens: true,
                clientId: 'client-id',
                openBrowser: false,
                redirectUri,
                timeoutMs: 2000,
            },
            logger,
        );
        tokenPromise.catch(authorizationUrlLogger.reject);

        const authorizeUrl = await authorizationUrlLogger.url;
        const state = authorizeUrl.searchParams.get('state');
        expect(state).toBeTruthy();

        const response = await fetch(`${redirectUri}?code=code&state=${state}`);
        expect(response.ok).toBe(true);

        await expect(tokenPromise).resolves.toMatchObject({
            accessToken: 'access-token',
            site: 'datadoghq.com',
        });
        expect(scope.isDone()).toBe(true);
    });
});
