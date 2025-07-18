// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile } from '@dd/core/helpers/fs';
import { getAbsolutePath } from '@dd/core/helpers/paths';
import { doRequest } from '@dd/core/helpers/request';
import { truncateString } from '@dd/core/helpers/strings';
import type { Logger, ToInjectItem } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';

import { AFTER_INJECTION, BEFORE_INJECTION, DISTANT_FILE_RX } from './constants';
import type { ContentsToInject } from './types';

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

export const processItem = async (
    item: ToInjectItem,
    log: Logger,
    cwd: string = process.cwd(),
): Promise<string | undefined> => {
    let result: string | undefined;
    const value = await getInjectedValue(item);
    try {
        if (item.type === 'file') {
            if (value.match(DISTANT_FILE_RX)) {
                result = await processDistantFile(value);
            } else {
                result = await processLocalFile(value, cwd);
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
            log.info(`Fallback for "${itemId}": ${error.toString()}`);
            result = await processItem(item.fallback, log, cwd);
        } else {
            // Or return an empty string.
            log.warn(`Failed "${itemId}": ${error.toString()}`);
        }
    }

    return result;
};

export const processInjections = async (
    toInject: Map<string, ToInjectItem>,
    log: Logger,
    cwd: string = process.cwd(),
): Promise<Map<string, { position: InjectPosition; value: string }>> => {
    const toReturn: Map<string, { position: InjectPosition; value: string }> = new Map();

    // Processing sequentially all the items.
    for (const [id, item] of toInject.entries()) {
        // eslint-disable-next-line no-await-in-loop
        const value = await processItem(item, log, cwd);
        if (value) {
            toReturn.set(id, { value, position: item.position || InjectPosition.BEFORE });
        }
    }

    return toReturn;
};

export const getContentToInject = (contentToInject: Map<string, string>) => {
    if (contentToInject.size === 0) {
        return '';
    }

    const stringToInject = Array.from(contentToInject.values())
        // Wrapping it in order to avoid variable name collisions.
        .map((content) => `(() => {${content}})();`)
        .join('\n\n');
    return `${BEFORE_INJECTION}\n${stringToInject}\n${AFTER_INJECTION}`;
};

// Prepare and fetch the content to inject.
export const addInjections = async (
    log: Logger,
    toInject: Map<string, ToInjectItem>,
    contentsToInject: ContentsToInject,
    cwd: string = process.cwd(),
) => {
    const results = await processInjections(toInject, log, cwd);
    // Redistribute the content to inject in the right place.
    for (const [id, value] of results.entries()) {
        contentsToInject[value.position].set(id, value.value);
    }
};
