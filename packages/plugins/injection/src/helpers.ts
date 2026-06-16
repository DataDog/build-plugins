// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile } from '@dd/core/helpers/fs';
import { getAbsolutePath } from '@dd/core/helpers/paths';
import { doRequest } from '@dd/core/helpers/request';
import { truncateString } from '@dd/core/helpers/strings';
import type { ChunkInfo, Logger, ToInjectItem } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import chalk from 'chalk';

import {
    AFTER_INJECTION,
    BEFORE_INJECTION,
    DISTANT_FILE_RX,
    SUPPORTED_EXTENSIONS,
} from './constants';
import type { ContentsToInject, ContentToInject } from './types';

const yellow = chalk.bold.yellow;

const MAX_TIMEOUT_IN_MS = 5000;

export const processDistantFile = async (
    url: string,
    timeout: number = MAX_TIMEOUT_IN_MS,
): Promise<string> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        doRequest<string>({
            // Don't delay the build too much on error.
            retries: 2,
            minTimeout: 100,
            url,
        }).finally(() => {
            if (timeout) {
                clearTimeout(timeoutId);
            }
        }),
        new Promise<string>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error('Timeout'));
            }, timeout);
        }),
    ]);
};

export const processLocalFile = async (
    filepath: string,
    cwd: string = process.cwd(),
): Promise<string> => {
    const absolutePath = getAbsolutePath(cwd, filepath);
    return readFile(absolutePath);
};

export function hasBeforeAfterInjection(contentsToInject: ContentToInject[]) {
    return contentsToInject.some(
        (content) =>
            content.position === InjectPosition.BEFORE || content.position === InjectPosition.AFTER,
    );
}

export function hasChunkInjection(contentsToInject: ContentToInject[]) {
    return contentsToInject.some((content) => content.injectIntoAllChunks);
}

export const getContentToInject = (
    contentToInject: ContentToInject[],
    position: InjectPosition,
    chunk?: ChunkInfo,
) => {
    const filtered = contentToInject.filter((content) => {
        return (
            content.position === position &&
            (!chunk || chunk.isEntry || content.injectIntoAllChunks)
        );
    });

    // Resolve function-valued content against the current chunk, drop empties.
    const values = filtered
        .map((content) => (isFunction(content.value) ? content.value(chunk!) : content.value))
        .filter(Boolean);

    if (values.length === 0) {
        return '';
    }

    const stringToInject = values
        // Wrapping it in order to avoid variable name collisions.
        .map((value) => `(() => {${value}})();`)
        .join('\n\n');
    return `${BEFORE_INJECTION}\n${stringToInject}\n${AFTER_INJECTION}`;
};

export const resolveWithFallback = async (
    item: ToInjectItem,
    log: Logger,
    cwd: string = process.cwd(),
): Promise<string> => {
    const value = isFunction(item.value) ? await item.value() : item.value;

    try {
        if (item.type === 'file') {
            const filePath = value;
            return await (filePath.match(DISTANT_FILE_RX)
                ? processDistantFile(filePath)
                : processLocalFile(filePath, cwd));
        }
        return value;
    } catch (error: any) {
        const itemId = `${item.type} - ${truncateString(value)}`;
        if (item.fallback) {
            log.debug(`Fallback for "${itemId}": ${error.toString()}`);
            return resolveWithFallback(item.fallback, log, cwd);
        }
        log.warn(`Failed "${itemId}": ${error.toString()}`);
        return '';
    }
};
export const prepareInjections = async (
    log: Logger,
    toInject: ToInjectItem[],
    contentsToInject: ContentsToInject,
    cwd: string = process.cwd(),
) => {
    // Per-chunk functions: adapt from public API (sourceOrHash?: string) to internal (chunk: ChunkInfo).
    const dynamicPerChunk = toInject.filter(isPerChunk).map((item) => {
        const userFn = item.value as (sourceOrHash?: string) => string;
        return { ...item, value: (chunk: ChunkInfo) => userFn(chunk.sourceOrHash) };
    });

    // Static items (strings and async loaders) are resolved once per build.
    const staticInject = toInject.filter((item) => !isPerChunk(item));
    const resolvedStaticInject = await Promise.all(
        staticInject.map(async (item) => ({
            ...item,
            value: await resolveWithFallback(item, log, cwd),
        })),
    );

    contentsToInject.push(...dynamicPerChunk, ...resolvedStaticInject);
};

export interface NodeSystemError extends Error {
    code: string;
}

export const isNodeSystemError = (e: unknown): e is NodeSystemError => {
    return e instanceof Error && 'code' in e;
};

export const isFileSupported = (ext: string): boolean => {
    return SUPPORTED_EXTENSIONS.includes(ext);
};

export const warnUnsupportedFile = (log: Logger, ext: string, filename: string): void => {
    log.warn(`"${yellow(ext)}" files are not supported (${yellow(filename)}).`);
};

const isPerChunk = (
    item: ToInjectItem,
): item is ToInjectItem & { value: (chunk: ChunkInfo) => string } =>
    typeof item.value === 'function' && item.value.length === 1;

const isFunction = (value: any): value is Function => typeof value === 'function';
