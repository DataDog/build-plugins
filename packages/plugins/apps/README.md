# Apps Plugin <!-- #omit in toc -->

A Vite plugin that builds a deployable Datadog Apps package. Publishing is owned by `@datadog/apps-cli`.

> [!WARNING]
> The Apps plugin is in **alpha** and is likely to break in most setups.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Package output](#package-output)
    -   [apps.enable](#appsenable)
    -   [apps.include](#appsinclude)
    -   [apps.authOverrides.method](#appsauthoverridesmethod)
    -   [apps.longPolling](#appslongpolling)
    -   [apps.description](#appsdescription)
    -   [apps.selfService](#appsselfservice)
    -   [apps.permissions](#appspermissions)
<!-- #toc -->

## Configuration

```ts
apps?: {
    enable?: boolean;
    include?: string[];
    description?: string;
    selfService?: boolean;
    permissions?: {
        protectionLevel?: 'direct_publish' | 'approval_required';
        runAs?: string;
    };
    authOverrides?: {
        method?: 'apiKey' | 'oauth';
    };
    longPolling?: {
        maxRetries?: number;
        jitter?: boolean;
        exponentialBackoff?: boolean;
        timeoutMs?: number;
    };
}
```

## Package output

A production `vite build` writes `datadog-apps-assets.zip` beside the Vite output. The ZIP contains `frontend/`, `backend/`, and `manifest.json`. The app's identity is resolved by `@datadog/apps-cli` at deploy time.

Set `DATADOG_APPS_PACKAGE_DIR` (or `DD_APPS_PACKAGE_DIR`) to write the archive to a different directory.

Use `datadog-apps build` to package locally, `datadog-apps upload` to create a draft, and `datadog-apps deploy` to upload and publish. Production packaging makes no Datadog API requests. Development-server backend functions retain their existing authentication behavior.

### apps.enable

> default: `true` when an `apps` config block is present, `false` otherwise.

Enable or disable the plugin without removing its configuration.

### apps.include

> default: `[]`

Additional glob patterns (relative to the project root) to include in the package. The bundler output directory is always included.

### apps.authOverrides.method

> default: `apiKey` when both `DD_API_KEY` and `DD_APP_KEY` are configured, otherwise `oauth`

Authentication method for uploading app bundles.

Use `apiKey` to send `DD_API_KEY`/`DD_APP_KEY` credentials from the shared `auth` config. Use `oauth` to complete a local Authorization Code + PKCE flow and upload with a short-lived bearer token instead.

When `apps.authOverrides.method` is not set, the plugin uses API/App-key auth if both keys are configured. If either key is missing, it uses OAuth by default.

You can also set `DATADOG_APPS_AUTH_METHOD` or `DD_APPS_AUTH_METHOD` to `apiKey` or `oauth`.

When the method is `oauth`, the plugin derives OAuth client settings from the resolved Datadog site. The plugin reads tokens from the OS credential store, refreshes expired access tokens when a refresh token is available, and only starts browser authorization when no usable stored token exists.

For first-time authorization, the plugin starts a temporary local HTTP callback server, opens Datadog authorization in the browser, exchanges the authorization code with PKCE, and saves the returned token response for later uploads.

### apps.longPolling

> default: `{ maxRetries: 10, jitter: true, exponentialBackoff: true, timeoutMs: 40000 }`

Controls how the dev server's `/__dd/executeAction` endpoint polls Datadog's long-poll execution API while waiting for a backend function to finish running.

-   `maxRetries`: maximum number of long-poll attempts before giving up. Set to `1` to disable long-polling retries entirely and only poll once.
-   `jitter`: randomize the delay before each retry so that several backend functions polling at the same time don't all retry in lockstep.
-   `exponentialBackoff`: grow the delay between retries exponentially instead of using a fixed delay.
-   `timeoutMs`: deadline for a single long-poll attempt. An attempt that stalls past it is abandoned and retried against the same receipt, so a dropped connection is re-polled instead of hanging indefinitely.

The retry delay is capped at 2s: the server answering `done: false` is the expected outcome of a healthy poll rather than a failure, and any delay here is time with no poll in flight.

> [!NOTE]
> `timeoutMs` must stay comfortably above the server's ~30s long-poll window. Setting it at or below that window causes healthy polls to be aborted as they race their own response.

OAuth token and authorization URLs are derived from `auth.site`, so it must match your Datadog data center (e.g. `datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`). If `auth.site` includes a custom subdomain (e.g. `myorg.us5.datadoghq.com`), the browser is sent to that subdomain for authorization, while the token exchange and upload requests still use the base site (`us5.datadoghq.com`).

### apps.description

Human-readable description included in the package manifest.

### apps.selfService

When true, the app appears in the Datadog self-service catalog.

### apps.permissions

`protectionLevel` controls direct publication versus approval requirements, and `runAs` identifies the service account that executes backend functions.
