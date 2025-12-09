# Apps Plugin <!-- #omit in toc -->

A plugin to upload assets to Datadog's storage

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Assets Upload](#assets-upload)
    -   [apps.enable](#appsenable)
    -   [apps.include](#appsinclude)
    -   [apps.dryRun](#appsdryrun)
<!-- #toc -->

## Configuration

```ts
apps?: {
    enable?: boolean;
    include?: string[];
    dryRun?: boolean;
}
```

## Assets Upload

Upload built assets to Datadog storage as a compressed archive.

> [!NOTE]
> You can override the domain used in the request with the `DATADOG_SITE` environment variable or the `auth.site` options (eg. `datadoghq.eu`).
> You can override the full intake URL by setting the `DATADOG_APPS_INTAKE_URL` environment variable (eg. `https://apps-intake.datadoghq.com/api/v1/apps`).

### apps.enable

> default: `true` when an `apps` config block is present

Enable or disable the plugin without removing its configuration.

### apps.include

> default: `[]`

Additional glob patterns (relative to the project root) to include in the uploaded archive. The bundler output directory is always included.

### apps.dryRun

> default: `false`

Prepare the archive and log the upload summary without sending anything to Datadog.
