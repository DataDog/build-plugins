// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, getOriginHeaders } from '@dd/core/helpers/request';
import type { Logger } from '@dd/core/types';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { gzip } from 'zlib';

import { SYMBOL_TABLE_INTAKE_PATH, SYMBOL_TABLE_INTAKE_SUBDOMAIN } from '../constants';

import type { SymbolTablePayload, SymDbScope } from './serialize';

const gzipAsync = promisify(gzip);

export type SymbolTableUploadContext = {
    apiKey: string;
    site: string;
    service: string;
    version: string;
    repositoryUrl: string;
    commitSha: string;
    bundlerName: string;
    pluginVersion: string;
};

export type UploadPart = {
    batchNum: number;
    final: boolean;
    // The gzipped file part.
    file: Buffer;
};

type FileContentArgs = {
    payload: SymbolTablePayload;
    context: SymbolTableUploadContext;
    uploadId: string;
    batchNum: number;
    final: boolean;
    scopes: SymDbScope[];
};

// The upload's file part: the symbol table, with the fields of each request.
const getFileContent = ({
    payload,
    context,
    uploadId,
    batchNum,
    final,
    scopes,
}: FileContentArgs): string => {
    const file = {
        service: context.service,
        version: context.version,
        language: payload.language,
        upload_id: uploadId,
        batch_num: batchNum,
        final,
        ...(payload.chunk_debug_ids ? { chunk_debug_ids: payload.chunk_debug_ids } : {}),
        scopes,
    };
    return JSON.stringify(file);
};

const compress = async (content: string): Promise<Buffer> => gzipAsync(content);

// Split the files into groups whose compressed size fits the limit. A single file that doesn't fit
// still gets its own group, and the intake rejects it.
const splitScopes = async (
    scopes: SymDbScope[],
    getCompressedSize: (scopes: SymDbScope[]) => Promise<number>,
    maxBytes: number,
): Promise<SymDbScope[][]> => {
    const compressedSize = await getCompressedSize(scopes);
    if (compressedSize <= maxBytes || scopes.length <= 1) {
        return [scopes];
    }

    const middle = Math.ceil(scopes.length / 2);
    const firstHalf = scopes.slice(0, middle);
    const secondHalf = scopes.slice(middle);
    const firstGroups = await splitScopes(firstHalf, getCompressedSize, maxBytes);
    const secondGroups = await splitScopes(secondHalf, getCompressedSize, maxBytes);
    return [...firstGroups, ...secondGroups];
};

/**
 * Split the symbol table by file into gzipped file parts of at most `maxBytes`. Most tables fit in
 * one part, which is then compressed only once.
 */
export const createUploadParts = async (
    payload: SymbolTablePayload,
    context: SymbolTableUploadContext,
    uploadId: string,
    maxBytes: number,
): Promise<UploadPart[]> => {
    const singleContent = getFileContent({
        payload,
        context,
        uploadId,
        batchNum: 1,
        final: true,
        scopes: payload.scopes,
    });
    const singleFile = await compress(singleContent);
    if (singleFile.length <= maxBytes) {
        return [{ batchNum: 1, final: true, file: singleFile }];
    }

    const getCompressedSize = async (scopes: SymDbScope[]) => {
        const content = getFileContent({
            payload,
            context,
            uploadId,
            batchNum: 1,
            final: false,
            scopes,
        });
        const file = await compress(content);
        return file.length;
    };
    const groups = await splitScopes(payload.scopes, getCompressedSize, maxBytes);

    const parts: UploadPart[] = [];
    for (const [index, scopes] of groups.entries()) {
        const batchNum = index + 1;
        const final = batchNum === groups.length;
        const content = getFileContent({ payload, context, uploadId, batchNum, final, scopes });
        // One part at a time, to keep memory low.
        // eslint-disable-next-line no-await-in-loop
        const file = await compress(content);
        parts.push({ batchNum, final, file });
    }

    return parts;
};

export const getIntakeUrl = (context: SymbolTableUploadContext): string => {
    const url = new URL(
        `https://${SYMBOL_TABLE_INTAKE_SUBDOMAIN}.${context.site}/${SYMBOL_TABLE_INTAKE_PATH}`,
    );
    const tags = [
        `git.repository_url:${context.repositoryUrl}`,
        `git.commit.sha:${context.commitSha}`,
    ];
    url.searchParams.set('ddtags', tags.join(','));
    return url.toString();
};

// The request of one part: an `event` part describing it, and the gzipped `file` part.
export const getPartData = (
    part: UploadPart,
    context: SymbolTableUploadContext,
    payload: SymbolTablePayload,
    uploadId: string,
) => {
    const event = {
        ddsource: 'dd_debugger',
        service: context.service,
        version: context.version,
        language: payload.language,
        runtimeId: uploadId,
        type: 'symdb',
        uploadId,
        batchNum: part.batchNum,
        final: part.final,
        attachmentSize: part.file.length,
    };
    const eventContent = JSON.stringify(event);
    const eventBlob = new Blob([eventContent], { type: 'application/json' });
    const fileBlob = new Blob([part.file], { type: 'application/gzip' });

    const form = new FormData();
    form.append('event', eventBlob, 'event.json');
    form.append('file', fileBlob, 'file.gz');

    const headers = getOriginHeaders({
        bundler: context.bundlerName,
        plugin: 'live-debugger',
        version: context.pluginVersion,
    });

    return { data: form, headers };
};

/**
 * Upload the symbol table to SymDB, one part at a time, and return the number of parts. Each build
 * uses a new upload ID, which SymDB also uses as the runtime ID, so a new upload for the same
 * service and version replaces the previous one.
 */
export const uploadSymbolTable = async (
    payload: SymbolTablePayload,
    context: SymbolTableUploadContext,
    maxBytes: number,
    log: Logger,
): Promise<number> => {
    const uploadId = randomUUID();
    const parts = await createUploadParts(payload, context, uploadId, maxBytes);
    const url = getIntakeUrl(context);

    for (const part of parts) {
        // In order, so the parts of an upload arrive in sequence.
        // eslint-disable-next-line no-await-in-loop
        await doRequest({
            url,
            method: 'POST',
            auth: { apiKey: context.apiKey },
            getData: () => getPartData(part, context, payload, uploadId),
            onRetry: (error, attempt) => {
                log.debug(
                    `Retrying part ${part.batchNum} of the symbol upload (attempt ${attempt}): ${error.message}`,
                );
            },
        });
    }

    return parts.length;
};
