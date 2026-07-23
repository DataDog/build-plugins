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

// Only the fields this file actually reads. app_builder_url is deliberately optional on both:
// see resolveAppBuilderUrl for what happens when the backend can't resolve it.
type UploadApiResponse = {
    app_builder_id?: string;
    app_builder_url?: string;
    version_id?: string;
};

type ReleaseApiResponse = {
    app_builder_id?: string;
    app_builder_url?: string;
};

export type UploadContext = {
    bundlerName: string;
    doAuthenticatedRequest: DoAuthenticatedRequest;
    dryRun: boolean;
    identifier: string;
    name: string;
    site: string;
    siteSubdomain?: string;
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

// The backend-provided app_builder_url is authoritative and always wins, even over our own
// subdomain config, since it reflects whatever the backend actually resolved for this org.
// Only when the backend can't resolve one do we build our own from site + subdomain (falling
// back to the generic "app" host) and the app_builder_id — this can only ever be a guess at
// the backend's URL scheme, so it's a fallback, not a replacement for the backend's own value.
const resolveAppBuilderUrl = (
    action: 'upload' | 'release',
    site: string,
    subdomain: string | undefined,
    appBuilderUrl: string | undefined,
    appBuilderId: string | undefined,
): string | undefined => {
    if (appBuilderUrl) {
        return appBuilderUrl;
    }

    if (!appBuilderId) {
        return undefined;
    }

    const path =
        action === 'upload'
            ? `/app-builder/apps/edit/${appBuilderId}?viewMode=preview`
            : `/app-builder/apps/${appBuilderId}`;
    return `https://${subdomain ?? 'app'}.${site}${path}`;
};

// Builds the warning shown when the backend couldn't resolve an org's App Builder URL and we
// don't even have an app_builder_id to construct a fallback link from. Names the app
// (context.name — always human-readable, unlike context.identifier's opaque hash) so users can
// find it in their App Builder apps list.
const buildMissingAppUrlWarning = (action: 'upload' | 'release', name: string) => {
    return `Could not resolve the App Builder URL for this ${action} — find "${name}" in your App Builder apps list to view it.`;
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
        const response = await doAuthenticatedRequest<UploadApiResponse>({
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

        const appBuilderUrl = resolveAppBuilderUrl(
            'upload',
            context.site,
            context.siteSubdomain,
            response.app_builder_url,
            response.app_builder_id,
        );
        if (appBuilderUrl) {
            log.info(`Your application is available at:\n  ${cyan(appBuilderUrl)}`);
        } else {
            // The backend couldn't resolve this org's App Builder URL and didn't even return
            // an app_builder_id to build a fallback link from (e.g. a transient lookup
            // failure) — the upload itself still succeeded, so this doesn't fail the build.
            const message = buildMissingAppUrlWarning('upload', context.name);
            warnings.push(message);
            log.warn(message);
        }

        const shouldPublish = parseBoolEnv(getDDEnvValue('APPS_PUBLISH'), true);

        if (response.version_id && shouldPublish) {
            const releaseUrl = getReleaseUrl(context.site, context.identifier);
            const releaseResponse = await doAuthenticatedRequest<ReleaseApiResponse>({
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

            const releaseAppBuilderUrl = resolveAppBuilderUrl(
                'release',
                context.site,
                context.siteSubdomain,
                releaseResponse.app_builder_url,
                // The release response can omit app_builder_id even though it identifies the
                // same app the upload response already resolved one for.
                releaseResponse.app_builder_id ?? response.app_builder_id,
            );
            if (releaseAppBuilderUrl) {
                log.info(
                    `Published uploaded version ${bold(response.version_id)} to live.\n  ${cyan(releaseAppBuilderUrl)}`,
                );
            } else {
                log.info(`Published uploaded version ${bold(response.version_id)} to live.`);
                const message = buildMissingAppUrlWarning('release', context.name);
                warnings.push(message);
                log.warn(message);
            }
        } else if (response.version_id && !shouldPublish) {
            log.info(`Uploaded version ${bold(response.version_id)} as a draft (publish skipped).`);
        }
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);
    }

    return { errors, warnings };
};
