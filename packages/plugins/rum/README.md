# RUM Plugin <!-- #omit in toc -->

Interact with our Real User Monitoring product (RUM) in Datadog directly from your build system.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Sourcemaps Upload](#sourcemaps-upload)
    -   [`rum.sourcemaps.bailOnError`](#rumsourcemapsbailonerror)
    -   [`rum.sourcemaps.dryRun`](#rumsourcemapsdryrun)
    -   [`rum.sourcemaps.intakeUrl`](#rumsourcemapsintakeurl)
    -   [`rum.sourcemaps.maxConcurrency`](#rumsourcemapsmaxconcurrency)
    -   [`rum.sourcemaps.minifiedPathPrefix`](#rumsourcemapsminifiedpathprefix)
    -   [`rum.sourcemaps.releaseVersion`](#rumsourcemapsreleaseversion)
    -   [`rum.sourcemaps.service`](#rumsourcemapsservice)
<!-- #toc -->

## Configuration

```ts
rum?: {
    disabled?: boolean;
    sourcemaps?: {
        bailOnError?: boolean;
        dryRun?: boolean;
        intakeUrl?: string;
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
> You can override the intake URL by setting the `DATADOG_SOURCEMAP_INTAKE_URL` environment variable (eg. `https://sourcemap-intake.datadoghq.com/v1/input`).
> Or only the domain with the `DATADOG_SITE` environment variable (eg. `datadoghq.com`).

### `rum.sourcemaps.bailOnError`

> default: `false`

Should the upload of sourcemaps fail the build on first error?

### `rum.sourcemaps.dryRun`

> default: `false`

It will not upload the sourcemaps to Datadog, but will do everything else.

### `rum.sourcemaps.intakeUrl`

> default: `https://sourcemap-intake.datadoghq.com/api/v2/srcmap`

Against which endpoint do you want to upload the sourcemaps.

### `rum.sourcemaps.maxConcurrency`

> default: `20`

Number of concurrent upload to the API.

### `rum.sourcemaps.minifiedPathPrefix`

> required

Should be a prefix common to all your JS source files, depending on the URL they are served from.

The prefix can be a full URL or an absolute path.

Example: if you're uploading `dist/file.js` to `https://example.com/static/file.js`, you can use `minifiedPathPrefix: 'https://example.com/static/'` or `minifiedPathPrefix: '/static/'`.`minifiedPathPrefix: '/'` is a valid input when you upload JS at the root directory of the server.

### `rum.sourcemaps.releaseVersion`

> required

Is similar and will be used to match the `version` tag set on the RUM SDK.

### `rum.sourcemaps.service`

> required

Should be set as the name of the service you're uploading sourcemaps for, and Datadog will use this service name to find the corresponding sourcemaps based on the `service` tag set on the RUM SDK.
