// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, outputFile, readFileSafeSync, truncateString } from '@dd/core/helpers';
import type { Logger, ToInjectItem } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import { getAbsolutePath } from '@dd/internal-build-report-plugin/helpers';
import { readFile } from 'fs/promises';

import { DISTANT_FILE_RX } from './constants';
import type { ContentsToInject, FileToInject, FilesToInject } from './types';

const MAX_TIMEOUT_IN_MS = 5000;

export const getInjectedValue = async (item: ToInjectItem): Promise<string> => {
    if (typeof item.value === 'function') {
        return item.value();
    }

    return item.value;
};

export const processDistantFile = async (
    url: string,
    timeout: number = MAX_TIMEOUT_IN_MS,
): Promise<string> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        doRequest<string>({ url }).finally(() => {
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

export const processLocalFile = async (filepath: string): Promise<string> => {
    const absolutePath = getAbsolutePath(process.cwd(), filepath);
    return readFile(absolutePath, { encoding: 'utf-8' });
};

export const processItem = async (item: ToInjectItem, log: Logger): Promise<string> => {
    let result: string;
    const value = await getInjectedValue(item);
    try {
        if (item.type === 'file') {
            if (value.match(DISTANT_FILE_RX)) {
                result = await processDistantFile(value);
            } else {
                result = await processLocalFile(value);
            }
        } else if (item.type === 'code') {
            // TODO: Confirm the code actually executes without errors.
            result = value;
        } else {
            throw new Error(`Invalid item type "${item.type}", only accepts "code" or "file".`);
        }
    } catch (error: any) {
        const itemId = `${item.type} - ${truncateString(value)}`;
        if (item.fallback) {
            // In case of any error, we'll fallback to next item in queue.
            log.warn(`Fallback for "${itemId}": ${error.toString()}`);
            result = await processItem(item.fallback, log);
        } else {
            // Or return an empty string.
            log.warn(`Failed "${itemId}": ${error.toString()}`);
            result = '';
        }
    }

    return result;
};

export const processInjections = async (
    toInject: Map<string, ToInjectItem>,
    log: Logger,
): Promise<Map<string, { position: InjectPosition; value: string }>> => {
    const toReturn: Map<string, { position: InjectPosition; value: string }> = new Map();

    // Processing sequentially all the items.
    for (const [id, item] of toInject.entries()) {
        // eslint-disable-next-line no-await-in-loop
        const value = await processItem(item, log);
        if (value) {
            toReturn.set(id, { value, position: item.position || InjectPosition.BEFORE });
        }
    }

    return toReturn;
};

export const getContentToInject = (contentToInject: Map<string, string>) => {
    // Needs a non empty string otherwise ESBuild will throw 'Do not know how to load path'.
    // Most likely because it tries to generate an empty file.
    const before = `// begin injection by Datadog build plugins`;
    const after = `// end injection by Datadog build plugins`;
    const stringToInject = Array.from(contentToInject.values()).join('\n\n');

    return `${before}\n${stringToInject}\n${after}`;
};

// Prepare and fetch the content to inject.
export const addInjections = async (
    log: Logger,
    toInject: Map<string, ToInjectItem>,
    contentsToInject: ContentsToInject,
) => {
    const results = await processInjections(toInject, log);
    // Redistribute the content to inject in the right place.
    for (const [id, value] of results.entries()) {
        contentsToInject[value.position].set(id, value.value);
    }
};

const handleInjectionFile = async (log: Logger, file: FileToInject) => {
    // Verify that the file doesn't already exist.
    const existingContent = readFileSafeSync(file.absolutePath);
    const contentToInject = getContentToInject(file.toInject);

    if (existingContent) {
        log.warn(`Temporary file "${file.filename}" already exists, will update.`);

        // No need to write into the file if the content is the same.
        // This is to prevent to trigger a re-build in dev mode.
        if (existingContent.trim() !== contentToInject.trim()) {
            return;
        }
    }

    return outputFile(file.absolutePath, contentToInject);
};

export const createFiles = async (log: Logger, getFilesToInject: () => FilesToInject) => {
    const proms = [];

    for (const file of Object.values(getFilesToInject())) {
        proms.push(handleInjectionFile(log, file));
    }

    // Wait for all the files to be created.
    await Promise.all(proms);
};
