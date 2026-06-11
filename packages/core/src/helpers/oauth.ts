// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import chalk from 'chalk';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import http from 'http';

import type { Logger } from '../types';

const OAUTH_PACKAGE_NAME = 'oauth4webapi';
const KEYRING_PACKAGE_NAME = '@napi-rs/keyring';

type OAuthAuthorizationServer = import('oauth4webapi').AuthorizationServer;
type OAuthClient = import('oauth4webapi').Client;
type OAuthModule = typeof import('oauth4webapi');
type OAuthTokenEndpointResponse = import('oauth4webapi').TokenEndpointResponse;
type KeyringModule = typeof import('@napi-rs/keyring');

// Load through a variable specifier so bundlers leave these as runtime requires
// instead of inlining them — notably the native `@napi-rs/keyring` binary. Node
// caches modules by specifier, so repeated calls reuse the same instance.
const loadOauth = () => import(OAUTH_PACKAGE_NAME) as Promise<OAuthModule>;
const loadKeyring = () => import(KEYRING_PACKAGE_NAME) as Promise<KeyringModule>;

export type OAuthConfig = {
    authorizationUrl: string;
    cacheTokens: boolean;
    clientId: string;
    openBrowser: boolean;
    redirectUri: string;
    timeoutMs: number;
    tokenUrl: string;
};

export const DEFAULT_OAUTH_CLIENT_ID = 'e17b9ffa-3daf-4124-ba1b-4ac8c547d506';
export const DATAD0G_OAUTH_CLIENT_ID = 'f4bacdd2-0c8c-49f5-bf3e-a62ba3ec02e6';
export const DEFAULT_OAUTH_REDIRECT_URI = 'http://localhost:8060';
export const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const OAUTH_TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
export const OAUTH_KEYCHAIN_SERVICE = 'datadog-build-plugins:oauth';

type OAuthCallback = {
    callbackParameters: URLSearchParams;
};

export type OAuthToken = {
    accessToken: string;
    expiresAt?: number;
    expiresIn?: number;
    refreshToken?: string;
    scope?: string;
    site: string;
    tokenType?: string;
};

export type CachedOAuthToken = Omit<OAuthToken, 'expiresIn'> & {
    clientId: string;
};

type StoredOAuthCredential = {
    token: CachedOAuthToken;
    version: 1;
};

const cyan = chalk.cyan.bold;

const base64Url = (buffer: Buffer) => buffer.toString('base64url');

export const generateCodeVerifier = () => base64Url(randomBytes(32));

export const generateCodeChallenge = async (codeVerifier: string) => {
    const oauth = await loadOauth();
    return oauth.calculatePKCECodeChallenge(codeVerifier);
};

export const getOAuthClientId = (site: string) => {
    switch (site) {
        case 'datad0g.com':
            return DATAD0G_OAUTH_CLIENT_ID;
        default:
            return DEFAULT_OAUTH_CLIENT_ID;
    }
};

export const getDatadogOAuthConfig = (site: string): OAuthConfig => {
    const clientId = getOAuthClientId(site);
    const baseOAuthUrl = `https://api.${site}/oauth2/v1`;

    return {
        authorizationUrl: `${baseOAuthUrl}/authorize`,
        cacheTokens: true,
        clientId,
        openBrowser: true,
        redirectUri: DEFAULT_OAUTH_REDIRECT_URI,
        timeoutMs: DEFAULT_OAUTH_TIMEOUT_MS,
        tokenUrl: `${baseOAuthUrl}/token`,
    };
};

const getOAuthClient = (clientId: string): OAuthClient => ({ client_id: clientId });

const getAuthorizationServer = (
    options: Pick<OAuthConfig, 'authorizationUrl' | 'tokenUrl'>,
): OAuthAuthorizationServer => {
    return {
        issuer: new URL(options.authorizationUrl).origin,
        authorization_endpoint: options.authorizationUrl,
        token_endpoint: options.tokenUrl,
    };
};

const getOAuthCredentialFingerprint = (
    site: string,
    options: Pick<OAuthConfig, 'authorizationUrl' | 'clientId' | 'tokenUrl'>,
) =>
    createHash('sha256')
        .update([options.clientId, site, options.authorizationUrl, options.tokenUrl].join('|'))
        .digest('hex')
        .slice(0, 16);

const getOAuthCredentialAccount = (
    site: string,
    options: Pick<OAuthConfig, 'authorizationUrl' | 'clientId' | 'tokenUrl'>,
) => `${site}:${options.clientId}:${getOAuthCredentialFingerprint(site, options)}`;

export const buildAuthorizationUrl = (opts: {
    authorizationUrl: string;
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    state: string;
}) => {
    const url = new URL(opts.authorizationUrl);
    url.searchParams.set('redirect_uri', opts.redirectUri);
    url.searchParams.set('client_id', opts.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', opts.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', opts.state);
    return url;
};

const tryOpenBrowser = (url: string) => {
    const opener =
        process.platform === 'darwin'
            ? { command: 'open', args: [url] }
            : process.platform === 'win32'
              ? { command: 'cmd', args: ['/c', 'start', '', url] }
              : { command: 'xdg-open', args: [url] };

    try {
        const child = spawn(opener.command, opener.args, {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    } catch {
        // Logging the URL is the reliable fallback.
    }
};

const respond = (res: http.ServerResponse, statusCode: number, body: string) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(body);
};

export const waitForOAuthCallback = async (opts: {
    authorizationServer: OAuthAuthorizationServer;
    client: OAuthClient;
    oauth: OAuthModule;
    redirectUri: string;
    state: string;
    timeoutMs: number;
}): Promise<OAuthCallback> => {
    const redirectUrl = new URL(opts.redirectUri);
    const port = Number(redirectUrl.port || 80);

    if (redirectUrl.protocol !== 'http:') {
        throw new Error('OAuth redirect URI must use http for the local OAuth callback.');
    }

    if (!Number.isInteger(port) || port <= 0) {
        throw new Error('OAuth redirect URI must include a valid port.');
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const server = http.createServer();

    try {
        return await new Promise<OAuthCallback>((resolve, reject) => {
            const finish = (fn: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                fn();
            };

            server.on('request', (req, res) => {
                const reqUrl = new URL(req.url || '/', redirectUrl.origin);
                if (reqUrl.pathname !== redirectUrl.pathname) {
                    respond(res, 404, 'Not found.');
                    return;
                }

                let callbackParameters: URLSearchParams;
                try {
                    callbackParameters = opts.oauth.validateAuthResponse(
                        opts.authorizationServer,
                        opts.client,
                        reqUrl,
                        opts.state,
                    );
                } catch (error) {
                    respond(res, 400, 'OAuth authorization failed. You may now close this tab.');
                    finish(() => reject(error instanceof Error ? error : new Error(String(error))));
                    return;
                }

                const code = callbackParameters.get('code');
                if (!code) {
                    respond(
                        res,
                        400,
                        'Missing OAuth authorization code. You may now close this tab.',
                    );
                    finish(() => reject(new Error('Missing OAuth authorization code.')));
                    return;
                }

                respond(res, 200, 'OAuth authorization complete. You may now close this tab.');
                finish(() => resolve({ callbackParameters }));
            });

            server.once('error', (error) => finish(() => reject(error)));

            timeout = setTimeout(() => {
                finish(() =>
                    reject(
                        new Error(
                            `Timed out waiting for OAuth callback after ${opts.timeoutMs}ms.`,
                        ),
                    ),
                );
            }, opts.timeoutMs);

            try {
                server.listen(port, redirectUrl.hostname);
            } catch (error) {
                finish(() => reject(error instanceof Error ? error : new Error(String(error))));
            }
        });
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        if (server.listening) {
            server.close();
            server.closeAllConnections?.();
            server.closeIdleConnections?.();
        }
    }
};

export const exchangeAuthorizationCode = async (opts: {
    callbackParameters: URLSearchParams;
    clientId: string;
    codeVerifier: string;
    redirectUri: string;
    site: string;
    tokenUrl: string;
    authorizationUrl: string;
}): Promise<OAuthToken> => {
    const oauth = await loadOauth();
    const authorizationServer = getAuthorizationServer(opts);
    const client = getOAuthClient(opts.clientId);
    const response = await oauth.authorizationCodeGrantRequest(
        authorizationServer,
        client,
        oauth.None(),
        opts.callbackParameters,
        opts.redirectUri,
        opts.codeVerifier,
    );
    const tokenResponse = await oauth.processAuthorizationCodeResponse(
        authorizationServer,
        client,
        response,
    );

    return tokenResponseToOAuthToken(tokenResponse, opts.site);
};

export const validateOAuthCallback = async (
    options: Pick<OAuthConfig, 'authorizationUrl' | 'clientId' | 'tokenUrl'>,
    callbackUrl: URL,
    state: string,
) => {
    const oauth = await loadOauth();
    return oauth.validateAuthResponse(
        getAuthorizationServer(options),
        getOAuthClient(options.clientId),
        callbackUrl,
        state,
    );
};

export const refreshOAuthToken = async (
    site: string,
    options: Pick<OAuthConfig, 'authorizationUrl' | 'clientId' | 'tokenUrl'>,
    refreshToken: string,
): Promise<OAuthToken> => {
    const oauth = await loadOauth();
    const authorizationServer = getAuthorizationServer(options);
    const client = getOAuthClient(options.clientId);
    const response = await oauth.refreshTokenGrantRequest(
        authorizationServer,
        client,
        oauth.None(),
        refreshToken,
    );
    const tokenResponse = await oauth.processRefreshTokenResponse(
        authorizationServer,
        client,
        response,
    );

    return tokenResponseToOAuthToken(
        {
            ...tokenResponse,
            refresh_token: tokenResponse.refresh_token || refreshToken,
        },
        site,
    );
};

const tokenResponseToOAuthToken = (
    tokenResponse: OAuthTokenEndpointResponse,
    site: string,
    receivedAt = Date.now(),
): OAuthToken => {
    return {
        accessToken: tokenResponse.access_token,
        expiresAt:
            typeof tokenResponse.expires_in === 'number'
                ? receivedAt + tokenResponse.expires_in * 1000
                : undefined,
        expiresIn: tokenResponse.expires_in,
        refreshToken: tokenResponse.refresh_token,
        scope: tokenResponse.scope,
        site,
        tokenType: tokenResponse.token_type,
    };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const getErrorCode = (error: unknown) =>
    isObject(error) && typeof error.code === 'string' ? error.code : undefined;

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const isNoEntryError = (error: unknown) => {
    const message = getErrorMessage(error).toLowerCase();
    return (
        getErrorCode(error) === 'NoEntry' ||
        message.includes('noentry') ||
        message.includes('no matching entry') ||
        message.includes('not found')
    );
};

const assertStoredOAuthCredential = (value: unknown): StoredOAuthCredential | undefined => {
    if (
        isObject(value) &&
        value.version === 1 &&
        isObject(value.token) &&
        typeof value.token.accessToken === 'string' &&
        typeof value.token.clientId === 'string' &&
        typeof value.token.site === 'string'
    ) {
        return value as StoredOAuthCredential;
    }

    return undefined;
};

const createOAuthCredentialEntry = async (
    site: string,
    options: Pick<OAuthConfig, 'authorizationUrl' | 'clientId' | 'tokenUrl'>,
) => {
    const { AsyncEntry } = await loadKeyring();
    return new AsyncEntry(OAUTH_KEYCHAIN_SERVICE, getOAuthCredentialAccount(site, options));
};

const secureStorageError = (operation: string, error: unknown) =>
    new Error(
        `Could not ${operation} Datadog OAuth token in the OS credential store. ${
            error instanceof Error ? error.message : String(error)
        }`,
    );

export const readOAuthTokenFromKeychain = async (
    site: string,
    options: Pick<OAuthConfig, 'authorizationUrl' | 'clientId' | 'tokenUrl'>,
): Promise<CachedOAuthToken | undefined> => {
    const entry = await createOAuthCredentialEntry(site, options);
    try {
        const raw = await entry.getPassword();
        if (!raw) {
            return undefined;
        }

        const parsed: unknown = JSON.parse(raw);
        return assertStoredOAuthCredential(parsed)?.token;
    } catch (error) {
        if (isNoEntryError(error)) {
            return undefined;
        }

        throw secureStorageError('read', error);
    }
};

export const writeOAuthTokenToKeychain = async (
    site: string,
    token: CachedOAuthToken,
    options: Pick<OAuthConfig, 'authorizationUrl' | 'clientId' | 'tokenUrl'>,
) => {
    const entry = await createOAuthCredentialEntry(site, options);
    const credential: StoredOAuthCredential = { version: 1, token };
    try {
        await entry.setPassword(JSON.stringify(credential));
    } catch (error) {
        throw secureStorageError('save', error);
    }
};

export const deleteOAuthTokenFromKeychain = async (
    site: string,
    options: Pick<OAuthConfig, 'authorizationUrl' | 'clientId' | 'tokenUrl'>,
) => {
    const entry = await createOAuthCredentialEntry(site, options);
    try {
        await entry.deletePassword();
    } catch (error) {
        if (!isNoEntryError(error)) {
            throw secureStorageError('delete', error);
        }
    }
};

const isCachedTokenValid = (token: CachedOAuthToken) =>
    token.expiresAt === undefined || token.expiresAt > Date.now() + OAUTH_TOKEN_EXPIRY_SKEW_MS;

const toCachedToken = (token: OAuthToken, clientId: string): CachedOAuthToken => ({
    accessToken: token.accessToken,
    clientId,
    expiresAt: token.expiresAt,
    refreshToken: token.refreshToken,
    scope: token.scope,
    site: token.site,
    tokenType: token.tokenType,
});

const fromCachedToken = (token: CachedOAuthToken): OAuthToken => ({
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    refreshToken: token.refreshToken,
    scope: token.scope,
    site: token.site,
    tokenType: token.tokenType,
});

const saveOAuthToken = async (
    token: OAuthToken,
    options: OAuthConfig,
    log: Logger,
    cacheSite = token.site,
) => {
    if (!options.cacheTokens) {
        return;
    }

    await writeOAuthTokenToKeychain(cacheSite, toCachedToken(token, options.clientId), options);
    log.debug('Saved Datadog OAuth token to the OS credential store.');
};

const deleteOAuthToken = async (site: string, options: OAuthConfig): Promise<void> => {
    if (!options.cacheTokens) {
        return;
    }

    await deleteOAuthTokenFromKeychain(site, options);
};

const getCachedOAuthToken = async (
    site: string,
    options: OAuthConfig,
    log: Logger,
): Promise<OAuthToken | undefined> => {
    if (!options.cacheTokens) {
        return undefined;
    }

    const cachedToken = await readOAuthTokenFromKeychain(site, options);
    if (!cachedToken) {
        return undefined;
    }

    if (isCachedTokenValid(cachedToken)) {
        log.debug('Using cached Datadog OAuth access token.');
        return fromCachedToken(cachedToken);
    }

    if (!cachedToken.refreshToken) {
        return undefined;
    }

    try {
        log.debug('Refreshing cached Datadog OAuth access token.');
        const refreshedToken = await refreshOAuthToken(site, options, cachedToken.refreshToken);
        await saveOAuthToken(refreshedToken, options, log);
        return refreshedToken;
    } catch (error) {
        log.warn(
            `Cached Datadog OAuth token could not be refreshed; starting browser authorization. ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        await deleteOAuthToken(site, options);
        return undefined;
    }
};

export const authorizeWithPKCE = async (
    site: string,
    options: OAuthConfig,
    log: Logger,
): Promise<OAuthToken> => {
    const oauth = await loadOauth();
    const authorizationServer = getAuthorizationServer(options);
    const client = getOAuthClient(options.clientId);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = base64Url(randomBytes(32));
    const authorizationUrl = buildAuthorizationUrl({
        authorizationUrl: options.authorizationUrl,
        clientId: options.clientId,
        codeChallenge,
        redirectUri: options.redirectUri,
        state,
    });

    const callbackPromise = waitForOAuthCallback({
        authorizationServer,
        client,
        oauth,
        redirectUri: options.redirectUri,
        state,
        timeoutMs: options.timeoutMs,
    });

    log.info(`Authorize Datadog Apps upload:\n  ${cyan(authorizationUrl.toString())}`);

    if (options.openBrowser) {
        tryOpenBrowser(authorizationUrl.toString());
    }

    const callback = await callbackPromise;
    return exchangeAuthorizationCode({
        callbackParameters: callback.callbackParameters,
        clientId: options.clientId,
        codeVerifier,
        redirectUri: options.redirectUri,
        site,
        tokenUrl: options.tokenUrl,
        authorizationUrl: options.authorizationUrl,
    });
};

export const getOAuthToken = async (
    site: string,
    options: OAuthConfig,
    log: Logger,
): Promise<OAuthToken> => {
    const cachedToken = await getCachedOAuthToken(site, options, log);
    if (cachedToken) {
        return cachedToken;
    }

    const token = await authorizeWithPKCE(site, options, log);
    await saveOAuthToken(token, options, log, site);
    return token;
};

// Memoize per site+client for the lifetime of the process so concurrent requests
// (and the sequential upload + release calls) share a single browser authorization.
const tokenCache = new Map<string, Promise<OAuthToken>>();

export const resolveOAuthToken = (site: string, log: Logger): Promise<OAuthToken> => {
    const options = getDatadogOAuthConfig(site);
    const key = `${site}:${options.clientId}`;
    let pending = tokenCache.get(key);
    if (!pending) {
        pending = getOAuthToken(site, options, log).catch((error) => {
            tokenCache.delete(key);
            throw error;
        });
        tokenCache.set(key, pending);
    }
    return pending;
};
