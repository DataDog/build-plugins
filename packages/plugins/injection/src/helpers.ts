// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, truncateString } from '@dd/core/helpers';
import type { Logger, ToInjectItem } from '@dd/core/types';
import { getAbsolutePath } from '@dd/internal-build-report-plugin/helpers';
import { readFile } from 'fs/promises';

import { DISTANT_FILE_RX } from './constants';

const MAX_TIMEOUT_IN_MS = 5000;

export const processDistantFile = async (
    item: ToInjectItem,
    timeout: number = MAX_TIMEOUT_IN_MS,
): Promise<string> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        doRequest<string>({ url: item.value }).finally(() => {
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

export const processLocalFile = async (item: ToInjectItem): Promise<string> => {
    const absolutePath = getAbsolutePath(process.cwd(), item.value);
    return readFile(absolutePath, { encoding: 'utf-8' });
};

export const processRawCode = async (item: ToInjectItem): Promise<string> => {
    // TODO: Confirm the code actually executes without errors.
    return item.value;
};

export const processItem = async (item: ToInjectItem, log: Logger): Promise<string> => {
    let result: string;
    try {
        if (item.type === 'file') {
            if (item.value.match(DISTANT_FILE_RX)) {
                result = await processDistantFile(item);
            } else {
                result = await processLocalFile(item);
            }
        } else if (item.type === 'code') {
            result = await processRawCode(item);
        } else {
            throw new Error(`Invalid item type "${item.type}", only accepts "code" or "file".`);
        }
    } catch (error: any) {
        const itemId = `${item.type} - ${truncateString(item.value)}`;
        if (item.fallback) {
            // In case of any error, we'll fallback to next item in queue.
            log(`Fallback for "${itemId}": ${error.toString()}`, 'warn');
            result = await processItem(item.fallback, log);
        } else {
            // Or return an empty string.
            log(`Failed "${itemId}": ${error.toString()}`, 'warn');
            result = '';
        }
    }

    return result;
};

export const processInjections = async (
    toInject: ToInjectItem[],
    log: Logger,
): Promise<string[]> => {
    const proms: (Promise<string> | string)[] = [];

    for (const item of toInject) {
        proms.push(processItem(item, log));
    }

    const results = await Promise.all(proms);
    return results.filter(Boolean);
};
