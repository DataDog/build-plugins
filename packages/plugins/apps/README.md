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
    -   [apps.authOverrides.method](#appsauthoverridesmethod)
    -   [apps.identifier](#appsidentifier)
    -   [apps.name](#appsname)
    -   [apps.publish](#appspublish)
<!-- #toc -->

## Configuration

```ts
apps?: {
    dryRun?: boolean;
    enable?: boolean;
    include?: string[];
    identifier?: string;
    name?: string;
    authOverrides?: {
        method?: 'apiKey' | 'oauth';
    };
    publish?: boolean;
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

> default: `true` when an `apps` config block is present, `false` otherwise.

Enable or disable the plugin without removing its configuration.

Must be a boolean. Non-boolean values are coerced today but will be rejected in a future major release.

### apps.include

> default: `[]`

Additional glob patterns (relative to the project root) to include in the uploaded archive. The bundler output directory is always included.

### apps.authOverrides.method

> default: `apiKey` when both `DD_API_KEY` and `DD_APP_KEY` are configured, otherwise `oauth`

Authentication method for uploading app bundles.

Use `apiKey` to send `DD_API_KEY`/`DD_APP_KEY` credentials from the shared `auth` config. Use `oauth` to complete a local Authorization Code + PKCE flow and upload with a short-lived bearer token instead.

When `apps.authOverrides.method` is not set, the plugin uses API/App-key auth if both keys are configured. If either key is missing, it uses OAuth by default.

You can also set `DATADOG_APPS_AUTH_METHOD` or `DD_APPS_AUTH_METHOD` to `apiKey` or `oauth`.

When the method is `oauth`, the plugin derives OAuth client settings from the resolved Datadog site. The plugin reads tokens from the OS credential store, refreshes expired access tokens when a refresh token is available, and only starts browser authorization when no usable stored token exists.

For first-time authorization, the plugin starts a temporary local HTTP callback server, opens Datadog authorization in the browser, exchanges the authorization code with PKCE, and saves the returned token response for later uploads.

OAuth token and authorization URLs are derived from `auth.site`, so it must match your Datadog data center (e.g. `datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`).

### apps.identifier

> default: an internal computation between the `name` and `repository` fields in `package.json` or from the `git` plugin.

Override the app's identifier used to identify the current app against the assets upload API.

Can be useful to enforce a static identifier instead of relying on possibly changing information like app's name and repository's url.

### apps.name

> default: extracted from the `name` field in `package.json`.

Override the app's name used in the assets upload API request.

Can be useful to enforce a static name instead of relying on the package.json name field.

### apps.publish

> default: `true`

When `true` (the default), the plugin publishes the uploaded version to live immediately after upload. Set to `false` to upload a draft without publishing it — useful for staging environments or CI pipelines where a separate approval step controls promotion.

You can also disable publishing via the `DATADOG_APPS_PUBLISH=false` (or `DD_APPS_PUBLISH=false`) environment variable. The explicit `apps.publish` config takes precedence over the environment variable.

To add a dedicated upload-without-publish command to your project, add this script to your `package.json`:

```json
{
    "scripts": {
        "upload": "DD_APPS_UPLOAD_ASSETS=1 vite build",
        "upload-no-publish": "DD_APPS_UPLOAD_ASSETS=1 DD_APPS_PUBLISH=false vite build"
    }
}
```
