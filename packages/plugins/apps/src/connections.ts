// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import type { ApiKeyRequestAuthOptions, Site } from '@dd/core/types';
import { Readable } from 'stream';

// NOTE: this targets a Custom Credentials connections endpoint that does not exist yet.
// The only place Custom Credentials connections can be created/updated/deleted today is a
// session-cookie-authenticated internal endpoint (`/api/v2/connection/custom_connections`,
// used by web-ui's connection form), which an API-key-authenticated CLI cannot call. This
// module is written against the shape that endpoint is expected to mirror once the
// actionplatform/connections team exposes an API-key-authenticated equivalent — treat the
// path and payload shape below as provisional until confirmed with that team.
export const CUSTOM_CONNECTIONS_API_PATH = 'api/unstable/actions/connections';

// A secret as read back from the API. Once stored, a secret is always `kind: 'SECRET'` —
// its plaintext value never round-trips back out; `ref` is an opaque handle that can be
// resent on update to mean "keep this secret's current value unchanged". A freshly-created
// EXTERNAL_SECRETS_MANAGER-backed token has no ref (there's nothing to un-encrypt).
export type SecretToken =
    | { name: string; kind: 'SECRET'; ref: string }
    | { name: string; kind: 'EXTERNAL_SECRETS_MANAGER' };

// A token as sent to the API when creating/updating a connection: either a brand-new/
// changed plaintext value, or an existing token carried forward unchanged by its `ref`.
export type SecretTokenInput = { name: string; value: string } | SecretToken;

type PostableToken =
    | { name: string; kind: 'PLAINTEXT'; plaintextValue: { value: string } }
    | { name: string; kind: 'SECRET'; secretValue: { value: string } }
    | { name: string; kind: 'EXTERNAL_SECRETS_MANAGER' };

type CustomConnectionAttributes = {
    name: string;
    kind: 'TOKEN_AUTH';
    integration: 'INTEGRATION_CUSTOM_CREDENTIALS';
    data: {
        tokenAuth: {
            tokens: PostableToken[];
        };
    };
};

// The wire shape of a stored token as returned by GET — `secretValue`/`externalSecretsManager`
// carry an opaque reference rather than the real value, mirroring how AWS credentials are
// returned (masked) elsewhere in the public Actions Connections API.
type RawToken = {
    name: string;
    kind: 'SECRET' | 'EXTERNAL_SECRETS_MANAGER' | 'PLAINTEXT';
    secretValue?: { value: string };
};

type CustomConnectionResponse = {
    data: {
        id: string;
        attributes: {
            name: string;
            data?: {
                tokenAuth?: {
                    tokens?: RawToken[];
                };
            };
        };
    };
};

const toPostableToken = (token: SecretTokenInput): PostableToken => {
    if ('value' in token) {
        return { name: token.name, kind: 'PLAINTEXT', plaintextValue: { value: token.value } };
    }
    if (token.kind === 'SECRET') {
        return { name: token.name, kind: 'SECRET', secretValue: { value: token.ref } };
    }
    return { name: token.name, kind: 'EXTERNAL_SECRETS_MANAGER' };
};

const fromRawToken = (token: RawToken): SecretToken => {
    if (token.kind === 'EXTERNAL_SECRETS_MANAGER') {
        return { name: token.name, kind: 'EXTERNAL_SECRETS_MANAGER' };
    }
    // A PLAINTEXT-kind token has no ref to carry forward. This shouldn't happen for a
    // stored token (the backend is expected to always convert to SECRET on save), but if
    // it does, surface it as a SECRET with an empty ref rather than silently dropping data
    // — callers (see apps-secrets `set`) must then either rotate or remove that name.
    return { name: token.name, kind: 'SECRET', ref: token.secretValue?.value ?? '' };
};

const buildAttributes = (name: string, tokens: SecretTokenInput[]): CustomConnectionAttributes => ({
    name,
    kind: 'TOKEN_AUTH',
    integration: 'INTEGRATION_CUSTOM_CREDENTIALS',
    data: { tokenAuth: { tokens: tokens.map(toPostableToken) } },
});

const jsonData = (body: unknown) => async () => ({
    data: Readable.from(JSON.stringify(body)),
    headers: { 'Content-Type': 'application/json' },
});

export type ConnectionsClient = {
    createSecretStore: (name: string, tokens: SecretTokenInput[]) => Promise<string>;
    getSecretStore: (connectionId: string) => Promise<{ name: string; tokens: SecretToken[] }>;
    updateSecretStore: (connectionId: string, tokens: SecretTokenInput[]) => Promise<void>;
    deleteSecretStore: (connectionId: string) => Promise<void>;
};

// Behind an interface so the real endpoint/payload shape can be swapped in behind
// getConnectionsClient() once the backend dependency (see module doc above) is resolved,
// without touching any call site.
export const getConnectionsClient = (
    auth: Required<ApiKeyRequestAuthOptions>,
    site: Site,
): ConnectionsClient => {
    const baseUrl = `https://api.${site}/${CUSTOM_CONNECTIONS_API_PATH}`;

    return {
        createSecretStore: async (name, tokens) => {
            const response = await doRequest<CustomConnectionResponse>({
                url: baseUrl,
                method: 'POST',
                type: 'json',
                auth,
                getData: jsonData({
                    data: { type: 'custom_connections', attributes: buildAttributes(name, tokens) },
                }),
            });
            return response.data.id;
        },

        getSecretStore: async (connectionId) => {
            const response = await doRequest<CustomConnectionResponse>({
                url: `${baseUrl}/${connectionId}`,
                type: 'json',
                auth,
            });
            return {
                name: response.data.attributes.name,
                tokens: (response.data.attributes.data?.tokenAuth?.tokens ?? []).map(fromRawToken),
            };
        },

        updateSecretStore: async (connectionId, tokens) => {
            await doRequest<CustomConnectionResponse>({
                url: `${baseUrl}/${connectionId}`,
                method: 'PATCH',
                type: 'json',
                auth,
                getData: jsonData({
                    data: {
                        type: 'custom_connections',
                        id: connectionId,
                        attributes: {
                            data: { tokenAuth: { tokens: tokens.map(toPostableToken) } },
                        },
                    },
                }),
            });
        },

        deleteSecretStore: async (connectionId) => {
            await doRequest<void>({
                url: `${baseUrl}/${connectionId}`,
                method: 'DELETE',
                auth,
            });
        },
    };
};
