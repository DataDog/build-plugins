// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getData, getIntakeUrl, getReleaseUrl, uploadArchive } from '@dd/apps-plugin/upload';
import { getDDEnvValue } from '@dd/core/helpers/env';
import { getFile } from '@dd/core/helpers/fs';
import { createRequestData, getOriginHeaders, NB_RETRIES } from '@dd/core/helpers/request';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import stripAnsi from 'strip-ansi';

jest.mock('@dd/core/helpers/env', () => {
    const actual = jest.requireActual('@dd/core/helpers/env');
    return {
        ...actual,
        getDDEnvValue: jest.fn(),
    };
});

jest.mock('@dd/core/helpers/fs', () => {
    const actual = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...actual,
        getFile: jest.fn(),
    };
});

jest.mock('@dd/core/helpers/request', () => {
    const actual = jest.requireActual('@dd/core/helpers/request');
    return {
        ...actual,
        createRequestData: jest.fn(),
        getOriginHeaders: jest.fn(),
    };
});

const getDDEnvValueMock = jest.mocked(getDDEnvValue);
const createRequestDataMock = jest.mocked(createRequestData);
const getFileMock = jest.mocked(getFile);
const getOriginHeadersMock = jest.mocked(getOriginHeaders);

describe('Apps Plugin - upload', () => {
    const archive = {
        archivePath: '/tmp/datadog-apps-assets.zip',
        assets: [{ absolutePath: '/tmp/a.js', relativePath: 'a.js' }],
        size: 1234,
    };
    const doAuthenticatedRequestMock = jest.fn();
    const context = {
        bundlerName: 'esbuild',
        doAuthenticatedRequest: doAuthenticatedRequestMock,
        dryRun: false,
        identifier: 'repo:app',
        name: 'test-app',
        site: 'datadoghq.com',
        version: '1.0.0',
    };
    const logger = getMockLogger();

    beforeEach(() => {
        doAuthenticatedRequestMock.mockReset();
        getOriginHeadersMock.mockReturnValue({
            'DD-EVP-ORIGIN': 'origin',
            'DD-EVP-ORIGIN-VERSION': '0.0.0',
        });
    });

    describe('getIntakeUrl', () => {
        test('Should use environment override when present', () => {
            getDDEnvValueMock.mockReturnValue('https://custom.apps');
            expect(getIntakeUrl('datadoghq.com', 'my-app')).toBe('https://custom.apps');
        });

        test('Should prefix for all Datadog sites', () => {
            getDDEnvValueMock.mockReturnValue(undefined);
            expect(getIntakeUrl('datadoghq.com', 'my-app')).toBe(
                'https://api.datadoghq.com/api/unstable/app-builder-code/apps/my-app/upload',
            );
            expect(getIntakeUrl('datadoghq.eu', 'my-app')).toBe(
                'https://api.datadoghq.eu/api/unstable/app-builder-code/apps/my-app/upload',
            );
            expect(getIntakeUrl('ddog-gov.com', 'my-app')).toBe(
                'https://api.ddog-gov.com/api/unstable/app-builder-code/apps/my-app/upload',
            );
            expect(getIntakeUrl('us5.datadoghq.com', 'my-app')).toBe(
                'https://api.us5.datadoghq.com/api/unstable/app-builder-code/apps/my-app/upload',
            );
            expect(getIntakeUrl('dd.datad0g.com', 'my-app')).toBe(
                'https://api.dd.datad0g.com/api/unstable/app-builder-code/apps/my-app/upload',
            );
        });
    });

    describe('getReleaseUrl', () => {
        test('Should prefix for all Datadog sites', () => {
            expect(getReleaseUrl('datadoghq.com', 'my-app')).toBe(
                'https://api.datadoghq.com/api/unstable/app-builder-code/apps/my-app/release/live',
            );
            expect(getReleaseUrl('datadoghq.eu', 'my-app')).toBe(
                'https://api.datadoghq.eu/api/unstable/app-builder-code/apps/my-app/release/live',
            );
            expect(getReleaseUrl('ddog-gov.com', 'my-app')).toBe(
                'https://api.ddog-gov.com/api/unstable/app-builder-code/apps/my-app/release/live',
            );
            expect(getReleaseUrl('us5.datadoghq.com', 'my-app')).toBe(
                'https://api.us5.datadoghq.com/api/unstable/app-builder-code/apps/my-app/release/live',
            );
            expect(getReleaseUrl('dd.datad0g.com', 'my-app')).toBe(
                'https://api.dd.datad0g.com/api/unstable/app-builder-code/apps/my-app/release/live',
            );
        });
    });

    describe('getData', () => {
        test('Should build form data with name and bundle', async () => {
            const fakeFile = { name: 'archive' };
            getFileMock.mockResolvedValue(fakeFile as any);
            createRequestDataMock.mockResolvedValue({
                data: 'data' as any,
                headers: { 'x-custom': '1' },
            });

            const getDataFn = getData('/tmp/archive.zip', { 'x-custom': '1' }, 'my-app');
            const data = await getDataFn();

            expect(getFileMock).toHaveBeenCalledWith('/tmp/archive.zip', {
                contentType: 'application/zip',
                filename: 'datadog-apps-assets.zip',
            });
            expect(createRequestDataMock).toHaveBeenCalledWith({
                getForm: expect.any(Function),
                defaultHeaders: { 'x-custom': '1' },
                zip: false,
            });
            expect(data).toEqual({ data: 'data', headers: { 'x-custom': '1' } });
        });

        test('Should append version to form when APPS_VERSION_NAME env var is set', async () => {
            const fakeFile = { name: 'archive' };
            getFileMock.mockResolvedValue(fakeFile as any);
            getDDEnvValueMock.mockImplementation((key) => {
                if (key === 'APPS_VERSION_NAME') {
                    return '1.2.3';
                }
                return undefined;
            });
            let capturedGetForm: (() => FormData | Promise<FormData>) | undefined;
            createRequestDataMock.mockImplementation(async (options) => {
                capturedGetForm = options.getForm;
                return { data: 'data' as any, headers: {} };
            });

            await getData('/tmp/archive.zip', {}, 'my-app')();

            // Mock append to avoid Blob validation errors from the non-Blob archiveFile fixture.
            const appendSpy = jest.spyOn(FormData.prototype, 'append').mockImplementation(() => {});
            await capturedGetForm!();
            expect(appendSpy).toHaveBeenCalledWith('version', '1.2.3');
            appendSpy.mockRestore();
        });

        test('Should not append version to form when APPS_VERSION_NAME env var is only whitespace', async () => {
            const fakeFile = { name: 'archive' };
            getFileMock.mockResolvedValue(fakeFile as any);
            getDDEnvValueMock.mockImplementation((key) => {
                if (key === 'APPS_VERSION_NAME') {
                    return '   ';
                }
                return undefined;
            });
            let capturedGetForm: (() => FormData | Promise<FormData>) | undefined;
            createRequestDataMock.mockImplementation(async (options) => {
                capturedGetForm = options.getForm;
                return { data: 'data' as any, headers: {} };
            });

            await getData('/tmp/archive.zip', {}, 'my-app')();

            const appendSpy = jest.spyOn(FormData.prototype, 'append').mockImplementation(() => {});
            await capturedGetForm!();
            expect(appendSpy).not.toHaveBeenCalledWith('version', expect.anything());
            appendSpy.mockRestore();
        });
    });

    describe('uploadArchive', () => {
        test('Should not require authentication for dry runs', async () => {
            const { errors, warnings } = await uploadArchive(
                archive,
                { ...context, dryRun: true },
                logger,
            );

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(doAuthenticatedRequestMock).not.toHaveBeenCalled();
        });

        test('Should fail when missing identifier', async () => {
            const { errors, warnings } = await uploadArchive(
                archive,
                { ...context, identifier: '' },
                logger,
            );
            expect(errors).toHaveLength(1);
            expect(errors[0].message).toBe('No app identifier provided');
            expect(warnings).toHaveLength(0);
            expect(doAuthenticatedRequestMock).not.toHaveBeenCalled();
        });

        test('Should log configuration and skip request on dryRun', async () => {
            const { errors, warnings } = await uploadArchive(
                archive,
                { ...context, dryRun: true },
                logger,
            );

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(doAuthenticatedRequestMock).not.toHaveBeenCalled();
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Dry run enabled'),
                'error',
            );
        });

        test('Should upload archive and log summary', async () => {
            doAuthenticatedRequestMock.mockResolvedValue({
                version_id: 'v123',
                application_id: 'app123',
                app_builder_id: 'builder123',
                app_builder_url:
                    'https://app.datadoghq.com/app-builder/apps/edit/builder123?viewMode=preview',
            } as any);

            const { errors, warnings } = await uploadArchive(archive, context, logger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(getOriginHeadersMock).toHaveBeenCalledWith({
                bundler: 'esbuild',
                plugin: 'apps',
                version: '1.0.0',
            });
            expect(doAuthenticatedRequestMock).toHaveBeenCalledWith({
                url: 'https://api.datadoghq.com/api/unstable/app-builder-code/apps/repo:app/upload',
                method: 'POST',
                type: 'json',
                getData: expect.any(Function),
                onRetry: expect.any(Function),
            });
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'https://app.datadoghq.com/app-builder/apps/edit/builder123?viewMode=preview',
                ),
                'info',
            );
        });

        test('Should use app_builder_url from upload response', async () => {
            doAuthenticatedRequestMock.mockResolvedValueOnce({
                version_id: 'v123',
                application_id: 'app123',
                app_builder_id: 'builder123',
                app_builder_url:
                    'https://dd.datad0g.com/app-builder/apps/edit/builder123?viewMode=preview',
            } as any);

            await uploadArchive(archive, context, logger);

            // Uses the exact URL from the response — proves it's not reconstructed from
            // context.site (datadoghq.com), which would produce a different domain.
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'https://dd.datad0g.com/app-builder/apps/edit/builder123?viewMode=preview',
                ),
                'info',
            );
        });

        test('Should warn (not error) when app_builder_url is absent from the upload response', async () => {
            // Skip the release call entirely — this test only cares about the upload log.
            getDDEnvValueMock.mockImplementation((key) =>
                key === 'APPS_PUBLISH' ? 'false' : undefined,
            );
            doAuthenticatedRequestMock.mockResolvedValueOnce({
                version_id: 'v123',
                application_id: 'app123',
                app_builder_id: 'builder123',
            } as any);

            const { errors, warnings } = await uploadArchive(archive, context, logger);

            // The upload itself succeeded — a missing display URL must never fail the build.
            expect(errors).toHaveLength(0);
            const uploadLog = mockLogFn.mock.calls.find(([message]) =>
                message.startsWith('Your application is available at'),
            );
            expect(uploadLog).toBeUndefined();
            // But it also must not go silent — surfaced as a warning so it's visible in CI
            // output (see handle-upload.ts, which logs and aggregates `warnings` without
            // failing the build, unlike `errors`). Names the app by its display name (not
            // context.identifier, which is an opaque hash — see identifier.ts) and includes
            // the app_builder_id, so there's a concrete, unambiguous next step (find it in
            // the apps list, disambiguated by ID if names collide), not just a generic warning.
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('Could not resolve the App Builder URL');
            expect(warnings[0]).toContain(context.name);
            expect(warnings[0]).toContain('builder123');

            // Reset — other tests in this file rely on getDDEnvValueMock's default
            // (undefined) behavior and beforeEach doesn't reset this particular mock.
            getDDEnvValueMock.mockReset();
        });

        test('Should omit the app ID suffix when app_builder_id is also absent', async () => {
            getDDEnvValueMock.mockImplementation((key) =>
                key === 'APPS_PUBLISH' ? 'false' : undefined,
            );
            // Matches the backend's own no-op-path edge case (app-builder-code's
            // TestAppBuilderURL_EmptyAppBuilderID) — both app_builder_id and
            // app_builder_url absent, not just the URL.
            doAuthenticatedRequestMock.mockResolvedValueOnce({
                version_id: 'v123',
                application_id: 'app123',
            } as any);

            const { warnings } = await uploadArchive(archive, context, logger);

            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain(context.name);
            expect(warnings[0]).not.toContain('app ID');

            getDDEnvValueMock.mockReset();
        });

        test('Should upload archive using the supplied request function', async () => {
            const doUploadAuthenticatedRequestMock = jest.fn().mockResolvedValue({
                version_id: 'v123',
                application_id: 'app123',
                app_builder_id: 'builder123',
                app_builder_url:
                    'https://app.datadoghq.com/app-builder/apps/edit/builder123?viewMode=preview',
            } as any);

            const { errors, warnings } = await uploadArchive(
                archive,
                {
                    ...context,
                    doAuthenticatedRequest: doUploadAuthenticatedRequestMock,
                },
                logger,
            );

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(doUploadAuthenticatedRequestMock).toHaveBeenCalledWith({
                url: 'https://api.datadoghq.com/api/unstable/app-builder-code/apps/repo:app/upload',
                method: 'POST',
                type: 'json',
                getData: expect.any(Function),
                onRetry: expect.any(Function),
            });
        });

        test('Should make PUT request to release version after successful upload', async () => {
            doAuthenticatedRequestMock
                .mockResolvedValueOnce({
                    version_id: 'v123',
                    application_id: 'app123',
                    app_builder_id: 'builder123',
                    app_builder_url:
                        'https://app.datadoghq.com/app-builder/apps/edit/builder123?viewMode=preview',
                })
                .mockResolvedValueOnce({
                    app_builder_url: 'https://app.datadoghq.com/app-builder/apps/builder123',
                });

            const { errors, warnings } = await uploadArchive(archive, context, logger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(doAuthenticatedRequestMock).toHaveBeenCalledTimes(2);
            expect(doAuthenticatedRequestMock).toHaveBeenNthCalledWith(2, {
                url: 'https://api.datadoghq.com/api/unstable/app-builder-code/apps/repo:app/release/live',
                method: 'PUT',
                type: 'json',
                getData: expect.any(Function),
                onRetry: expect.any(Function),
            });
            // Pin down which log is which by its distinguishing message prefix — proves not
            // just that a matching call exists somewhere, but that the upload log specifically
            // carries ?viewMode=preview and the release log specifically doesn't.
            const uploadLog = mockLogFn.mock.calls.find(([message]) =>
                message.startsWith('Your application is available at'),
            );
            const releaseLog = mockLogFn.mock.calls.find(([message]) =>
                message.startsWith('Published uploaded version'),
            );
            expect(uploadLog?.[0]).toContain(
                'https://app.datadoghq.com/app-builder/apps/edit/builder123?viewMode=preview',
            );
            expect(releaseLog?.[0]).toContain(
                'https://app.datadoghq.com/app-builder/apps/builder123',
            );
            expect(releaseLog?.[0]).not.toContain('?viewMode');
        });

        test('Should use app_builder_url from release response', async () => {
            doAuthenticatedRequestMock
                .mockResolvedValueOnce({
                    version_id: 'v123',
                    application_id: 'app123',
                    app_builder_id: 'builder123',
                    app_builder_url:
                        'https://dd.datad0g.com/app-builder/apps/edit/builder123?viewMode=preview',
                })
                .mockResolvedValueOnce({
                    app_builder_url: 'https://dd.datad0g.com/app-builder/apps/builder123',
                });

            await uploadArchive(archive, context, logger);

            // Match the release log by its distinguishing message prefix — proves the
            // published URL reflects the custom domain from the release response (not
            // context.site) and carries no ?viewMode (unlike the upload log).
            const releaseLog = mockLogFn.mock.calls.find(([message]) =>
                message.startsWith('Published uploaded version'),
            );
            expect(releaseLog?.[0]).toContain('https://dd.datad0g.com/app-builder/apps/builder123');
            expect(releaseLog?.[0]).not.toContain('?viewMode');
        });

        test('Should warn (not error) when app_builder_url is absent from the release response', async () => {
            doAuthenticatedRequestMock
                .mockResolvedValueOnce({
                    version_id: 'v123',
                    application_id: 'app123',
                    app_builder_id: 'builder123',
                    app_builder_url:
                        'https://app.datadoghq.com/app-builder/apps/edit/builder123?viewMode=preview',
                })
                // The backend couldn't resolve the org's app URL for this release — a real,
                // designed-for degradation path (e.g. a transient org-lookup failure), not a
                // hypothetical. The release itself still succeeded. app_builder_id is still
                // present, though — it's set from the DB independently of the URL lookup.
                .mockResolvedValueOnce({ app_builder_id: 'builder123' });

            const { errors, warnings } = await uploadArchive(archive, context, logger);

            // The release itself succeeded — a missing display URL must never fail the build.
            expect(errors).toHaveLength(0);
            const releaseLog = mockLogFn.mock.calls.find(([message]) =>
                message.startsWith('Published uploaded version'),
            );
            // Still confirms the release happened, just without a trailing URL line.
            expect(releaseLog?.[0]).toContain('to live.');
            expect(releaseLog?.[0]).not.toContain('\n');
            // Surfaced as a warning rather than a blank/malformed log line — names the app
            // by its display name and includes the app_builder_id for unambiguous lookup.
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('Could not resolve the App Builder URL');
            expect(warnings[0]).toContain(context.name);
            expect(warnings[0]).toContain('builder123');
        });

        test.each(['false', '0', 'False', 'FALSE', 'off', 'no'])(
            'Should skip release/live call when DD_APPS_PUBLISH=%s',
            async (publishValue) => {
                getDDEnvValueMock.mockImplementation((key) =>
                    key === 'APPS_PUBLISH' ? publishValue : undefined,
                );
                doAuthenticatedRequestMock.mockResolvedValueOnce({
                    version_id: 'v123',
                    application_id: 'app123',
                    app_builder_id: 'builder123',
                    app_builder_url:
                        'https://app.datadoghq.com/app-builder/apps/edit/builder123?viewMode=preview',
                });

                const { errors } = await uploadArchive(archive, context, logger);

                expect(errors).toHaveLength(0);
                expect(doAuthenticatedRequestMock).toHaveBeenCalledTimes(1);
                expect(doAuthenticatedRequestMock).toHaveBeenCalledWith(
                    expect.objectContaining({ method: 'POST' }),
                );
                doAuthenticatedRequestMock.mockReset();
                getOriginHeadersMock.mockReturnValue({
                    'DD-EVP-ORIGIN': 'origin',
                    'DD-EVP-ORIGIN-VERSION': '0.0.0',
                });
            },
        );

        test('Should skip release/live call and log draft message when DD_APPS_PUBLISH=false', async () => {
            getDDEnvValueMock.mockImplementation((key) =>
                key === 'APPS_PUBLISH' ? 'false' : undefined,
            );
            doAuthenticatedRequestMock.mockResolvedValueOnce({
                version_id: 'v123',
                application_id: 'app123',
                app_builder_id: 'builder123',
                app_builder_url:
                    'https://app.datadoghq.com/app-builder/apps/edit/builder123?viewMode=preview',
            });

            const { errors, warnings } = await uploadArchive(archive, context, logger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            // Only the upload POST — no release PUT.
            expect(doAuthenticatedRequestMock).toHaveBeenCalledTimes(1);
            expect(doAuthenticatedRequestMock).toHaveBeenCalledWith(
                expect.objectContaining({ method: 'POST' }),
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('draft (publish skipped)'),
                'info',
            );
        });

        test('Should collect warnings on retries', async () => {
            doAuthenticatedRequestMock.mockImplementation(async (opts) => {
                opts.onRetry?.(new Error('network'), 2);
            });

            const { warnings } = await uploadArchive(archive, context, logger);

            expect(warnings).toHaveLength(1);
            expect(stripAnsi(warnings[0])).toBe(
                `Failed to upload archive (attempt 2/${NB_RETRIES}): network`,
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Failed to upload archive'),
                'warn',
            );
        });

        test('Should return errors when upload fails', async () => {
            doAuthenticatedRequestMock.mockRejectedValue(new Error('boom'));

            const { errors } = await uploadArchive(archive, context, logger);

            expect(errors).toHaveLength(1);
            expect(errors[0].message).toBe('boom');
        });
    });
});
