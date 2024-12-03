// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, truncateString } from '@dd/core/helpers';
import type { Logger, ToInjectItem } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import { getAbsolutePath } from '@dd/internal-build-report-plugin/helpers';
import { readFile } from 'fs/promises';

import { DISTANT_FILE_RX } from './constants';

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
