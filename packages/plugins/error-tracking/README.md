# Error Tracking Plugin <!-- #omit in toc -->

Interact with Error Tracking directly from your build system.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Sourcemaps Upload](#sourcemaps-upload)
    -   [errorTracking.sourcemaps.bailOnError](#errortrackingsourcemapsbailonerror)
    -   [errorTracking.sourcemaps.dryRun](#errortrackingsourcemapsdryrun)
    -   [errorTracking.sourcemaps.maxConcurrency](#errortrackingsourcemapsmaxconcurrency)
    -   [errorTracking.sourcemaps.minifiedPathPrefix](#errortrackingsourcemapsminifiedpathprefix)
    -   [errorTracking.sourcemaps.releaseVersion](#errortrackingsourcemapsreleaseversion)
    -   [errorTracking.sourcemaps.service](#errortrackingsourcemapsservice)
<!-- #toc -->

## Configuration

```ts
errorTracking?: {
    enable?: boolean;
    sourcemaps?: {
        bailOnError?: boolean;
        dryRun?: boolean;
        maxConcurrency?: number;
        minifiedPathPrefix: string;
        releaseVersion: string;
        service: string;
    };
}
```

## Sourcemaps Upload

Upload JavaScript sourcemaps to Datadog to un-minify your errors.

> [!NOTE]
> You can override the domain used in the request with the `DATADOG_SITE` environment variable or the `auth.site` options (eg. `datadoghq.eu`).
> You can override the full intake URL by setting the `DATADOG_SOURCEMAP_INTAKE_URL` environment variable (eg. `https://sourcemap-intake.datadoghq.com/v1/input`).

### errorTracking.sourcemaps.bailOnError

> default: `false`

Should the upload of sourcemaps fail the build on first error?

### errorTracking.sourcemaps.dryRun

> default: `false`

It will not upload the sourcemaps to Datadog, but will do everything else.


### errorTracking.sourcemaps.maxConcurrency

> default: `20`

Number of concurrent upload to the API.

### errorTracking.sourcemaps.minifiedPathPrefix

> required

Should be a prefix common to all your JS source files, depending on the URL they are served from.

The prefix can be a full URL or an absolute path.

Example: if you're uploading `dist/file.js` to `https://example.com/static/file.js`, you can use `minifiedPathPrefix: 'https://example.com/static/'` or `minifiedPathPrefix: '/static/'`.`minifiedPathPrefix: '/'` is a valid input when you upload JS at the root directory of the server.

### errorTracking.sourcemaps.releaseVersion

> required

Is similar and will be used to match the `version` tag set on the RUM SDK.

### errorTracking.sourcemaps.service

> required

Should be set as the name of the service you're uploading sourcemaps for, and Datadog will use this service name to find the corresponding sourcemaps based on the `service` tag set on the RUM SDK.

> [!NOTE]
>
> If you get the error `Error: No git remotes available`,
> you can disable the git integration via the `enableGit` configuration at the root.
> It will also remove any usage of git for additional information on your files.
