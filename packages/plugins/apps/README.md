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
    -   [apps.description](#appsdescription)
    -   [apps.selfService](#appsselfservice)
    -   [apps.permissions.protectionLevel](#appspermissionsprotectionlevel)
    -   [apps.permissions.runAs](#appspermissionsrunas)
    -   [apps.publish](#appspublish)
    -   [apps.secretConnections](#appssecretconnections)
-   [Secret Store CLI](#secret-store-cli)
<!-- #toc -->

## Configuration

```ts
apps?: {
    dryRun?: boolean;
    enable?: boolean;
    include?: string[];
    identifier?: string;
    name?: string;
    description?: string;
    selfService?: boolean;
    permissions?: {
        protectionLevel?: 'direct_publish' | 'approval_required';
        runAs?: string;
    };
    authOverrides?: {
        method?: 'apiKey' | 'oauth';
    };
    publish?: boolean;
    secretConnections?: string[];
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

### apps.description

> default: `undefined` (preserves existing description)

Human-readable description for the app. Set once at initial deploy; subsequent deploys without this field leave the existing description unchanged.

### apps.selfService

> default: `undefined` (preserves existing setting)

When `true`, the app appears in the Datadog self-service catalog so other users can run it from a central directory. When `false`, the app is hidden from the catalog. Omitting this field leaves the existing setting unchanged.

### apps.permissions.protectionLevel

> default: `undefined` (preserves existing setting)

Controls whether publishing the app requires a second approver.

- `direct_publish` — any user with publish rights can deploy immediately.
- `approval_required` — a second editor must approve before the app goes live.

Omitting this field leaves the existing setting unchanged.

### apps.permissions.runAs

> default: `undefined` (preserves existing setting)

UUID of the service account the app's backend functions run as. When set, all backend function executions use this service account's credentials instead of the uploading user's. Omitting this field leaves the existing setting unchanged.

> [!NOTE]
> Only service accounts are accepted. Arbitrary user UUIDs are rejected by the Datadog API. The caller must have `service_account_write` permission and the service account's role set must be a subset of the caller's roles.

### apps.publish

> default: `true`

When `true` (the default), the plugin publishes the uploaded version to live immediately after upload. Set to `false` to upload a draft without publishing it.

You can also disable publishing via the `DATADOG_APPS_PUBLISH=false` (or `DD_APPS_PUBLISH=false`) environment variable. The explicit `apps.publish` config takes precedence over the environment variable.

The `datadog-apps deploy --no-publish` CLI command sets this automatically — prefer the CLI over configuring this directly.

### apps.secretConnections

> default: `undefined` (no additional connections)

IDs of Custom Credentials connections (secret stores) to make available to **every** backend function of this app, regardless of whether that function's code references a `connectionId`. Each connection's secrets are injected as environment variables at runtime (e.g. a secret named `STRIPE_API_KEY` is available as `process.env.STRIPE_API_KEY`).

Managed via the `apps-secrets` CLI (see [Secret Store CLI](#secret-store-cli) below), which creates the connection and adds its ID here automatically — you shouldn't normally need to edit this by hand.

> [!WARNING]
> Creating/updating/deleting Custom Credentials connections currently requires a backend endpoint that Datadog has not yet exposed for API-key-authenticated callers. Until that endpoint exists, the `apps-secrets` CLI commands below cannot succeed against a real org — see [Secret Store CLI](#secret-store-cli).

## Secret Store CLI

Manage Custom Credentials secret stores from the command line with `yarn cli apps-secrets <subcommand>`:

-   `apps-secrets create --name FOO --name BAR` — creates a new secret store, prompts for each secret's value (never accepted as a command argument), and adds the resulting connection ID to `apps.secretConnections` in your Vite config.
-   `apps-secrets set [connectionId] --name FOO --remove BAR` — adds/updates secrets (prompting for new values) and/or removes secrets on the connection configured in your Vite config. Pass `connectionId` explicitly if you have more than one.
-   `apps-secrets delete [connectionId]` — deletes the connection and removes it from your Vite config.
-   `apps-secrets list` — prints the secret *names* on each configured connection. Secret values are never printed — the API doesn't return them once stored.

Each subcommand accepts `--config <path>` to point at a Vite config file other than `vite.config.ts`.

> [!WARNING]
> As noted above, these commands depend on a backend endpoint that doesn't exist yet for API-key-authenticated callers — they will not work against a real Datadog org until that dependency is resolved.
