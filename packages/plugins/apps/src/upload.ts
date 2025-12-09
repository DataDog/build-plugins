// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import { createGzipFormData } from '@dd/core/helpers/form';
import { getFile } from '@dd/core/helpers/fs';
import { doRequest, getOriginHeaders, NB_RETRIES } from '@dd/core/helpers/request';
import type { Logger } from '@dd/core/types';
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';

import type { Archive } from './archive';
import { APPS_API_PATH, APPS_API_SUBDOMAIN, ARCHIVE_FILENAME } from './constants';
import type { AppsOptionsWithDefaults } from './types';

type DataResponse = Awaited<ReturnType<typeof createGzipFormData>>;

export type UploadContext = {
    apiKey?: string;
    bundlerName: string;
    site: string;
    version: string;
};

const green = chalk.green.bold;
const yellow = chalk.yellow.bold;
const cyan = chalk.cyan.bold;

export const getIntakeUrl = (site: string) => {
    const envIntake = getDDEnvValue('APPS_INTAKE_URL');
    return envIntake || `https://${APPS_API_SUBDOMAIN}.${site}/${APPS_API_PATH}`;
};

export const getData =
    (archivePath: string, defaultHeaders: Record<string, string> = {}) =>
    async (): Promise<DataResponse> => {
        const archiveFile = await getFile(archivePath, {
            contentType: 'application/zip',
            filename: ARCHIVE_FILENAME,
        });

        return createGzipFormData((form) => {
            form.append('archive', archiveFile, ARCHIVE_FILENAME);
        }, defaultHeaders);
    };

export const uploadArchive = async (
    archive: Archive,
    options: AppsOptionsWithDefaults,
    context: UploadContext,
    log: Logger,
) => {
    const errors: Error[] = [];
    const warnings: string[] = [];

    if (!context.apiKey) {
        errors.push(new Error('No authentication token provided'));
        return { errors, warnings };
    }

    const intakeUrl = getIntakeUrl(context.site);
    const defaultHeaders = getOriginHeaders({
        bundler: context.bundlerName,
        plugin: 'apps',
        version: context.version,
    });

    const configurationString = Object.entries({
        ...options,
        intakeUrl,
        defaultHeaders: `\n${JSON.stringify(defaultHeaders, null, 2)}`,
    })
        .map(([key, value]) => `    - ${key}: ${green(value.toString())}`)
        .join('\n');

    const summary = `an archive of:
  - ${green(archive.assets.length.toString())} files
  - ${green(prettyBytes(archive.size))}

With the configuration:\n${configurationString}`;

    if (options.dryRun) {
        // Using log.error to ensure it's printed with high priority.
        log.error(
            `\n${cyan('Dry run enabled')}\n
Skipping assets upload.
Would have uploaded ${summary}`,
        );
        return { errors, warnings };
    }

    try {
        await doRequest({
            auth: { apiKey: context.apiKey },
            url: intakeUrl,
            method: 'POST',
            getData: getData(archive.archivePath, defaultHeaders),
            onRetry: (error: Error, attempt: number) => {
                const message = `Failed to upload archive (attempt ${yellow(
                    `${attempt}/${NB_RETRIES}`,
                )}): ${error.message}`;
                warnings.push(message);
                log.warn(message);
            },
        });
        log.info(`Uploaded ${summary}`);
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);
    }

    return { errors, warnings };
};
