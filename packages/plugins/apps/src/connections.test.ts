// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getConnectionsClient } from '@dd/apps-plugin/connections';
import { doRequest } from '@dd/core/helpers/request';

jest.mock('@dd/core/helpers/request', () => {
    const actual = jest.requireActual('@dd/core/helpers/request');
    return {
        ...actual,
        doRequest: jest.fn(),
    };
});

const doRequestMock = jest.mocked(doRequest);
const auth = { apiKey: 'api-key', appKey: 'app-key' };

const readBody = async (stream: AsyncIterable<Buffer | string>) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
};

// This client targets an endpoint that does not exist yet for API-key-authenticated
// callers (see connections.ts's module doc) — these tests only pin down the request/
// response shape this module is written against, not that it works against a real API.
describe('Apps Plugin - connections', () => {
    beforeEach(() => {
        doRequestMock.mockReset();
    });

    describe('createSecretStore', () => {
        test('Should POST a custom_connections payload and return the new id', async () => {
            doRequestMock.mockResolvedValue({
                data: { id: 'conn-123', attributes: { name: 'x' } },
            });

            const client = getConnectionsClient(auth, 'datadoghq.com');
            const id = await client.createSecretStore('My secrets', [
                { name: 'STRIPE_API_KEY', value: 'sk_live_123' },
            ]);

            expect(id).toBe('conn-123');
            expect(doRequestMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://api.datadoghq.com/api/unstable/actions/connections',
                    method: 'POST',
                    type: 'json',
                    auth,
                    getData: expect.any(Function),
                }),
            );

            const { getData } = doRequestMock.mock.calls[0][0];
            const { data } = await getData!();
            const body = await readBody(data as any);
            expect(body).toEqual({
                data: {
                    type: 'custom_connections',
                    attributes: {
                        name: 'My secrets',
                        kind: 'TOKEN_AUTH',
                        integration: 'INTEGRATION_CUSTOM_CREDENTIALS',
                        data: {
                            tokenAuth: {
                                tokens: [
                                    {
                                        name: 'STRIPE_API_KEY',
                                        kind: 'PLAINTEXT',
                                        plaintextValue: { value: 'sk_live_123' },
                                    },
                                ],
                            },
                        },
                    },
                },
            });
        });
    });

    describe('getSecretStore', () => {
        test('Should GET the connection and map tokens, never exposing plaintext values', async () => {
            doRequestMock.mockResolvedValue({
                data: {
                    id: 'conn-123',
                    attributes: {
                        name: 'My secrets',
                        data: {
                            tokenAuth: {
                                tokens: [
                                    {
                                        name: 'STRIPE_API_KEY',
                                        kind: 'SECRET',
                                        secretValue: { value: 'ref-1' },
                                    },
                                ],
                            },
                        },
                    },
                },
            });

            const client = getConnectionsClient(auth, 'datadoghq.com');
            const store = await client.getSecretStore('conn-123');

            expect(doRequestMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://api.datadoghq.com/api/unstable/actions/connections/conn-123',
                    type: 'json',
                    auth,
                }),
            );
            expect(store).toEqual({
                name: 'My secrets',
                tokens: [{ name: 'STRIPE_API_KEY', kind: 'SECRET', ref: 'ref-1' }],
            });
        });

        test('Should return an empty tokens array when the connection has none', async () => {
            doRequestMock.mockResolvedValue({
                data: { id: 'conn-123', attributes: { name: 'My secrets' } },
            });

            const client = getConnectionsClient(auth, 'datadoghq.com');
            const store = await client.getSecretStore('conn-123');

            expect(store.tokens).toEqual([]);
        });
    });

    describe('updateSecretStore', () => {
        test('Should PATCH with the full merged token array', async () => {
            doRequestMock.mockResolvedValue({
                data: { id: 'conn-123', attributes: { name: 'x' } },
            });

            const client = getConnectionsClient(auth, 'datadoghq.com');
            await client.updateSecretStore('conn-123', [
                { name: 'UNCHANGED', kind: 'SECRET', ref: 'ref-1' },
                { name: 'ROTATED', value: 'new-value' },
            ]);

            expect(doRequestMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://api.datadoghq.com/api/unstable/actions/connections/conn-123',
                    method: 'PATCH',
                    type: 'json',
                    auth,
                }),
            );

            const { getData } = doRequestMock.mock.calls[0][0];
            const { data } = await getData!();
            const body = await readBody(data as any);
            expect(body.data.attributes.data.tokenAuth.tokens).toEqual([
                { name: 'UNCHANGED', kind: 'SECRET', secretValue: { value: 'ref-1' } },
                { name: 'ROTATED', kind: 'PLAINTEXT', plaintextValue: { value: 'new-value' } },
            ]);
        });
    });

    describe('deleteSecretStore', () => {
        test('Should DELETE the connection', async () => {
            doRequestMock.mockResolvedValue(undefined);

            const client = getConnectionsClient(auth, 'datadoghq.com');
            await client.deleteSecretStore('conn-123');

            expect(doRequestMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://api.datadoghq.com/api/unstable/actions/connections/conn-123',
                    method: 'DELETE',
                    auth,
                }),
            );
        });
    });
});
