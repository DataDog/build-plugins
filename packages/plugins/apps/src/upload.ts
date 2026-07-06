// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue, parseBoolEnv } from '@dd/core/helpers/env';
import { getFile } from '@dd/core/helpers/fs';
import { createRequestData, getOriginHeaders, NB_RETRIES } from '@dd/core/helpers/request';
import { prettyObject } from '@dd/core/helpers/strings';
import type { Logger } from '@dd/core/types';
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';
import { Readable } from 'stream';

import type { Archive } from './archive';
import type { DoAuthenticatedRequest } from './auth';
import { APPS_API_PATH, ARCHIVE_FILENAME } from './constants';

type DataResponse = Awaited<ReturnType<typeof createRequestData>>;

export type UploadContext = {
    bundlerName: string;
    doAuthenticatedRequest: DoAuthenticatedRequest;
    dryRun: boolean;
    identifier: string;
    name: string;
    site: string;
    version: string;
};

const green = chalk.green.bold;
const yellow = chalk.yellow.bold;
const cyan = chalk.cyan.bold;
const bold = chalk.bold;

export const getIntakeUrl = (site: string, appId: string) => {
    const envIntake = getDDEnvValue('APPS_INTAKE_URL');
    return envIntake || `https://api.${site}/${APPS_API_PATH}/${appId}/upload`;
};

export const getReleaseUrl = (site: string, appId: string) => {
    return `https://api.${site}/${APPS_API_PATH}/${appId}/release/live`;
};

export const getData =
    (archivePath: string, defaultHeaders: Record<string, string> = {}, name: string) =>
    async (): Promise<DataResponse> => {
        const archiveFile = await getFile(archivePath, {
            contentType: 'application/zip',
            filename: ARCHIVE_FILENAME,
        });

        return createRequestData({
            getForm: () => {
                const form = new FormData();
                form.append('name', name);
                form.append('bundle', archiveFile, ARCHIVE_FILENAME);
                const versionName = getDDEnvValue('APPS_VERSION_NAME')?.trim();
                if (versionName) {
                    form.append('version', versionName);
                }
                return form;
            },
            defaultHeaders,
            zip: false,
        });
    };

export const uploadArchive = async (archive: Archive, context: UploadContext, log: Logger) => {
    const errors: Error[] = [];
    const warnings: string[] = [];
    const doAuthenticatedRequest = context.doAuthenticatedRequest;

    if (!context.identifier) {
        errors.push(new Error('No app identifier provided'));
        return { errors, warnings };
    }

    const intakeUrl = getIntakeUrl(context.site, context.identifier);
    const defaultHeaders = getOriginHeaders({
        bundler: context.bundlerName,
        plugin: 'apps',
        version: context.version,
    });

    const configurationString = prettyObject({
        identifier: context.identifier,
        intakeUrl,
        defaultHeaders: `\n${JSON.stringify(defaultHeaders, null, 2)}`,
    });

    const summary = `an archive of:
  - ${green(archive.assets.length.toString())} files
  - ${green(prettyBytes(archive.size))}

With the configuration:\n${configurationString}`;

    if (context.dryRun) {
        // Using log.error to ensure it's printed with high priority.
        log.error(
            `\n${cyan('Dry run enabled')}\n
Skipping assets upload.
Would have uploaded ${summary}`,
        );
        return { errors, warnings };
    }

    try {
        const response: any = await doAuthenticatedRequest({
            url: intakeUrl,
            method: 'POST',
            type: 'json',
            getData: getData(archive.archivePath, defaultHeaders, context.name),
            onRetry: (error: Error, attempt: number) => {
                const message = `Failed to upload archive (attempt ${yellow(
                    `${attempt}/${NB_RETRIES}`,
                )}): ${error.message}`;
                warnings.push(message);
                log.warn(message);
            },
        });

        log.debug(`Uploaded ${summary}\n`);

        if (response.app_builder_url) {
            log.info(`Your application is available at:\n  ${cyan(response.app_builder_url)}`);
        }

        const shouldPublish = parseBoolEnv(getDDEnvValue('APPS_PUBLISH'), true);

        if (response.version_id && shouldPublish) {
            const releaseUrl = getReleaseUrl(context.site, context.identifier);
            const releaseResponse: any = await doAuthenticatedRequest({
                url: releaseUrl,
                method: 'PUT',
                type: 'json',
                getData: async () => ({
                    data: Readable.from(JSON.stringify({ version_id: response.version_id })),
                    headers: {
                        'Content-Type': 'application/json',
                        ...defaultHeaders,
                    },
                }),
                onRetry: (error: Error, attempt: number) => {
                    const message = `Failed to release version (attempt ${yellow(
                        `${attempt}/${NB_RETRIES}`,
                    )}): ${error.message}`;
                    warnings.push(message);
                    log.warn(message);
                },
            });

            log.info(
                `Published uploaded version ${bold(response.version_id)} to live.\n  ${cyan(releaseResponse.app_builder_url)}`,
            );
        } else if (response.version_id && !shouldPublish) {
            log.info(`Uploaded version ${bold(response.version_id)} as a draft (publish skipped).`);
        }
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);
    }

    return { errors, warnings };
};
