// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { gunzipSync } from 'zlib';

import type { SymbolTablePayload, SymDbScope } from './serialize';
import type { SymbolTableUploadContext } from './upload';
import { createUploadParts, getIntakeUrl, uploadSymbolTable } from './upload';

jest.mock('@dd/core/helpers/request', () => {
    const original = jest.requireActual('@dd/core/helpers/request');
    return {
        ...original,
        doRequest: jest.fn(),
    };
});

const doRequestMock = jest.mocked(doRequest);

const CONTEXT: SymbolTableUploadContext = {
    apiKey: 'api-key',
    site: 'datadoghq.com',
    service: 'shop',
    version: '1.2.3',
    repositoryUrl: 'https://github.com/DataDog/shop',
    commitSha: 'abc123',
    bundlerName: 'webpack',
    pluginVersion: '3.3.3',
};

const MAX_PART_BYTES = 50 * 1024 * 1024;

const getModuleScope = (index: number): SymDbScope => ({
    scope_type: 'MODULE',
    name: `src/file-${index}.js`,
    source_file: `src/file-${index}.js`,
    scopes: [
        {
            scope_type: 'FUNCTION',
            name: `function${index}`,
            source_file: `src/file-${index}.js`,
            start_line: 1,
            end_line: 3,
            language_specifics: { function_id: `src/file-${index}.js;function${index}` },
        },
    ],
});

const getPayload = (moduleCount: number): SymbolTablePayload => ({
    language: 'browser',
    version: CONTEXT.version,
    chunk_debug_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    scopes: Array.from({ length: moduleCount }, (_, index) => getModuleScope(index)),
});

const readJson = (file: Buffer) => {
    const content = gunzipSync(file).toString('utf-8');
    return JSON.parse(content);
};

const readFormPart = async (form: FormData, name: string) => {
    const part = form.get(name);
    if (!part || typeof part === 'string') {
        throw new Error(`Missing the "${name}" part.`);
    }
    const buffer = await part.arrayBuffer();
    return { part, content: Buffer.from(buffer) };
};

describe('Symbol table upload', () => {
    beforeEach(() => {
        doRequestMock.mockReset();
    });

    test('Should post one part with the event and the gzipped symbol table.', async () => {
        const payload = getPayload(2);

        const partCount = await uploadSymbolTable(
            payload,
            CONTEXT,
            MAX_PART_BYTES,
            getMockLogger(),
        );

        expect(partCount).toBe(1);
        expect(doRequestMock).toHaveBeenCalledTimes(1);
        const [requestOptions] = doRequestMock.mock.calls[0];
        expect(requestOptions).toEqual(
            expect.objectContaining({
                url: getIntakeUrl(CONTEXT),
                method: 'POST',
                auth: { apiKey: 'api-key' },
            }),
        );

        const data = await requestOptions.getData?.();
        if (!(data?.data instanceof FormData)) {
            throw new Error('Expected a multipart body.');
        }
        expect(data.headers).toEqual(
            expect.objectContaining({ 'DD-EVP-ORIGIN': 'webpack-build-plugin_live-debugger' }),
        );

        const event = await readFormPart(data.data, 'event');
        const file = await readFormPart(data.data, 'file');
        const eventJson = JSON.parse(event.content.toString('utf-8'));
        const fileJson = readJson(file.content);

        expect(event.part.name).toBe('event.json');
        expect(file.part.name).toBe('file.gz');
        expect(eventJson).toEqual({
            ddsource: 'dd_debugger',
            service: 'shop',
            version: '1.2.3',
            language: 'browser',
            runtimeId: eventJson.uploadId,
            type: 'symdb',
            uploadId: expect.any(String),
            batchNum: 1,
            final: true,
            attachmentSize: file.content.length,
        });
        expect(fileJson).toEqual({
            service: 'shop',
            version: '1.2.3',
            language: 'browser',
            upload_id: eventJson.uploadId,
            batch_num: 1,
            final: true,
            chunk_debug_ids: payload.chunk_debug_ids,
            scopes: payload.scopes,
        });
    });

    test('Should use a new upload ID for every upload.', async () => {
        const payload = getPayload(1);
        const uploadIds: string[] = [];

        for (let index = 0; index < 2; index++) {
            // eslint-disable-next-line no-await-in-loop
            await uploadSymbolTable(payload, CONTEXT, MAX_PART_BYTES, getMockLogger());
            const [requestOptions] = doRequestMock.mock.calls[index];
            // eslint-disable-next-line no-await-in-loop
            const data = await requestOptions.getData?.();
            if (!(data?.data instanceof FormData)) {
                throw new Error('Expected a multipart body.');
            }
            // eslint-disable-next-line no-await-in-loop
            const event = await readFormPart(data.data, 'event');
            const eventJson = JSON.parse(event.content.toString('utf-8'));
            uploadIds.push(eventJson.uploadId);
        }

        expect(uploadIds[0]).not.toBe(uploadIds[1]);
    });

    test('Should tag the upload with its git repository and commit.', () => {
        const url = new URL(getIntakeUrl(CONTEXT));

        expect(url.origin).toBe('https://debugger-intake.datadoghq.com');
        expect(url.pathname).toBe('/api/v2/debugger');
        expect(url.searchParams.get('ddtags')).toBe(
            'git.repository_url:https://github.com/DataDog/shop,git.commit.sha:abc123',
        );
    });

    test('Should split a table that is too big by file, in numbered parts.', async () => {
        const payload = getPayload(5);
        const singlePart = await createUploadParts(payload, CONTEXT, 'upload-id', MAX_PART_BYTES);
        // Too small for the whole table, but big enough for one file.
        const maxBytes = singlePart[0].file.length - 1;

        const parts = await createUploadParts(payload, CONTEXT, 'upload-id', maxBytes);
        const files = parts.map((part) => readJson(part.file));
        const partScopes = files.flatMap((file) => file.scopes);

        expect(parts.length).toBeGreaterThan(1);
        expect(parts.map((part) => part.batchNum)).toEqual(
            Array.from({ length: parts.length }, (_, index) => index + 1),
        );
        expect(parts.map((part) => part.final)).toEqual(
            Array.from({ length: parts.length }, (_, index) => index === parts.length - 1),
        );
        expect(files.map((file) => file.batch_num)).toEqual(parts.map((part) => part.batchNum));
        expect(files.every((file) => file.upload_id === 'upload-id')).toBe(true);
        expect(partScopes).toEqual(payload.scopes);
    });
});
