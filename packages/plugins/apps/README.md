# Apps Plugin <!-- #omit in toc -->

A plugin to upload assets to Datadog's storage

> [!WARNING]
> The Apps plugin is in **alpha** and is likely to break in most setups.
> Use it only for experimentation; behavior and APIs may change without notice.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Assets Upload](#assets-upload)
    -   [apps.dryRun](#appsdryrun)
    -   [apps.enable](#appsenable)
    -   [apps.include](#appsinclude)
    -   [apps.identifier](#appsidentifier)
    -   [apps.name](#appsname)
<!-- #toc -->

## Configuration

```ts
apps?: {
    dryRun?: boolean;
    enable?: boolean;
    include?: string[];
    identifier?: string;
    name?: string;
}
```

## Assets Upload

Upload built assets to Datadog storage as a compressed archive.

> [!NOTE]
> You can override the domain used in the request with the `DATADOG_SITE` environment variable or the `auth.site` options (eg. `datadoghq.eu`).
> You can override the full intake URL by setting the `DATADOG_APPS_INTAKE_URL` environment variable (eg. `https://apps-intake.datadoghq.com/api/v1/apps`).

### apps.dryRun

> default: `true`

Prepare the archive and log the upload summary without sending anything to Datadog.

Set to `false` to actually upload assets to Datadog. You can also enable uploads by setting the `DATADOG_APPS_UPLOAD_ASSETS` (or `DD_APPS_UPLOAD_ASSETS`) environment variable.

Setting the `apps.dryRun` configuration will override any value set in the environment variable.

### apps.enable

> default: `true` when an `apps` config block is present

Enable or disable the plugin without removing its configuration.

### apps.include

> default: `[]`

Additional glob patterns (relative to the project root) to include in the uploaded archive. The bundler output directory is always included.

### apps.identifier

> default: an internal computation between the `name` and `repository` fields in `package.json` or from the `git` plugin.

Override the app's identifier used to identify the current app against the assets upload API.

Can be useful to enforce a static identifier instead of relying on possibly changing information like app's name and repository's url.

### apps.name

> default: extracted from the `name` field in `package.json`.

Override the app's name used in the assets upload API request.

Can be useful to enforce a static name instead of relying on the package.json name field.
