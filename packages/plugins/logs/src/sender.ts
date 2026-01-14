// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import { doRequest, NB_RETRIES } from '@dd/core/helpers/request';
import type { AuthOptions, Logger } from '@dd/core/types';
import chalk from 'chalk';
import PQueue from 'p-queue';

import { LOGS_API_PATH, LOGS_API_SUBDOMAIN } from './constants';
import type { DatadogLogEntry, LogsOptionsWithDefaults } from './types';

const green = chalk.green.bold;
const yellow = chalk.yellow.bold;

export const getIntakeUrl = (site: string) => {
    const envIntake = getDDEnvValue('LOGS_INTAKE_URL');
    return envIntake || `https://${LOGS_API_SUBDOMAIN}.${site}/${LOGS_API_PATH}`;
};

type SendResult = {
    errors: Error[];
    warnings: string[];
};

/**
 * Creates a getData function for a batch of logs.
 * This follows the pattern from error-tracking sender.
 */
const getLogData =
    (logs: DatadogLogEntry[]) =>
    async (): Promise<{ data: string; headers: Record<string, string> }> => {
        return {
            data: JSON.stringify(logs),
            headers: {
                'Content-Type': 'application/json',
            },
        };
    };

/**
 * Send logs to Datadog Logs API in batches.
 * Uses p-queue for concurrent batch uploads and doRequest for retries.
 */
export const sendLogs = async (
    logs: DatadogLogEntry[],
    options: LogsOptionsWithDefaults,
    auth: AuthOptions,
    log: Logger,
): Promise<SendResult> => {
    const errors: Error[] = [];
    const warnings: string[] = [];

    if (!auth.apiKey) {
        errors.push(new Error('No API key provided'));
        return { errors, warnings };
    }

    if (logs.length === 0) {
        return { errors, warnings };
    }

    const intakeUrl = getIntakeUrl(auth.site || 'datadoghq.com');

    // Split logs into batches
    const batches: DatadogLogEntry[][] = [];
    for (let i = 0; i < logs.length; i += options.batchSize) {
        batches.push(logs.slice(i, i + options.batchSize));
    }

    log.info(
        `Sending ${green(logs.length.toString())} logs in ${green(batches.length.toString())} batches to ${green(intakeUrl)}`,
    );

    // @ts-expect-error PQueue's default isn't typed.
    const Queue = PQueue.default ? PQueue.default : PQueue;
    const queue = new Queue({ concurrency: 5 });

    const addPromises = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];

        addPromises.push(
            queue.add(async () => {
                try {
                    await doRequest({
                        auth: { apiKey: auth.apiKey },
                        url: intakeUrl,
                        method: 'POST',
                        getData: getLogData(batch),
                        onRetry: (error: Error, attempt: number) => {
                            const warningMessage = `Failed to send log batch ${batchIndex + 1}/${batches.length}:\n  ${error.message}\nRetrying ${attempt}/${NB_RETRIES}`;
                            warnings.push(warningMessage);
                            log.debug(warningMessage);
                        },
                    });
                } catch (e: any) {
                    errors.push(
                        new Error(`Batch ${batchIndex + 1}/${batches.length} failed: ${e.message}`),
                    );
                }
            }),
        );
    }

    await Promise.all(addPromises);
    await queue.onIdle();

    if (errors.length === 0) {
        log.debug(`Successfully sent all ${yellow(logs.length.toString())} logs`);
    }

    return { errors, warnings };
};
