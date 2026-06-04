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
    -   [apps.authOverride.method](#appsauthoverridemethod)
    -   [apps.identifier](#appsidentifier)
    -   [apps.name](#appsname)
<!-- #toc -->

## Configuration

```ts
auth?: {
    apiKey?: string;
    appKey?: string;
    site?: string;
}

apps?: {
    authOverride?: {
        method?: 'apiKey' | 'oauth';
    };
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

> default: `true` when an `apps` config block is present, `false` otherwise.

Enable or disable the plugin without removing its configuration.

Must be a boolean. Non-boolean values are coerced today but will be rejected in a future major release.

### apps.include

> default: `[]`

Additional glob patterns (relative to the project root) to include in the uploaded archive. The bundler output directory is always included.

### apps.authOverride.method

> default: `apiKey`

Authentication method override for Apps API calls.

Use `apiKey` to send `DD_API_KEY`/`DD_APP_KEY` credentials. Use `oauth` to complete a local Authorization Code + PKCE flow and call Apps APIs with a short-lived bearer token instead.

You can also set `DATADOG_APPS_AUTH_METHOD=oauth` or `DD_APPS_AUTH_METHOD=oauth`.

When `apps.authOverride.method` is `oauth`, the plugin derives OAuth client settings from the resolved Datadog site. The plugin reads tokens from the OS credential store, refreshes expired access tokens when a refresh token is available, and only starts browser authorization when no usable stored token exists.

For first-time authorization, the plugin starts a temporary local HTTP callback server, opens Datadog authorization in the browser, exchanges the authorization code with PKCE, and saves the returned token response for later uploads.

OAuth token and authorization URLs are site-based. The `datad0g.com` site uses the internal Datadog Apps OAuth client; all other sites use the default Datadog Apps OAuth client.

### apps.identifier

> default: an internal computation between the `name` and `repository` fields in `package.json` or from the `git` plugin.

Override the app's identifier used to identify the current app against the assets upload API.

Can be useful to enforce a static identifier instead of relying on possibly changing information like app's name and repository's url.

### apps.name

> default: extracted from the `name` field in `package.json`.

Override the app's name used in the assets upload API request.

Can be useful to enforce a static name instead of relying on the package.json name field.
