# Apps Plugin <!-- #omit in toc -->

A Vite plugin that builds a deployable Datadog Apps package. Publishing is owned by `@datadog/apps-cli`.

> [!WARNING]
> The Apps plugin is in **alpha** and is likely to break in most setups.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Development server authentication](#development-server-authentication)
-   [Package output](#package-output)
    -   [apps.enable](#appsenable)
    -   [apps.include](#appsinclude)
    -   [apps.longPolling](#appslongpolling)
<!-- #toc -->

## Configuration

```ts
apps?: {
    enable?: boolean;
    include?: string[];
    longPolling?: {
        maxRetries?: number;
        jitter?: boolean;
        exponentialBackoff?: boolean;
        timeoutMs?: number;
    };
}
```

## Development server authentication

Backend function execution authenticates in this order:

1. `DD_API_KEY`/`DATADOG_API_KEY` + `DD_APP_KEY`/`DATADOG_APP_KEY` (API-key auth)
2. `DD_OAUTH_ACCESS_TOKEN` (or `DATADOG_OAUTH_ACCESS_TOKEN`)

`datadog-apps dev` resolves and refreshes an OAuth token for your org, then
passes it to the dev server via `DD_OAUTH_ACCESS_TOKEN`. When no credentials are
configured, backend function execution is unavailable and the dev server tells
you to start it with `datadog-apps dev`.

## Package output

A production `vite build` writes `datadog-app-assets.zip` beside the Vite output. The ZIP contains `frontend/`, `backend/`, and `manifest.json`. The app's identity is resolved by `@datadog/apps-cli` at deploy time.

Set `DATADOG_APPS_PACKAGE_DIR` (or `DD_APPS_PACKAGE_DIR`) to write the archive to a different directory.

Use `datadog-apps build` to package locally, `datadog-apps upload` to create a draft, and `datadog-apps deploy` to upload and publish. Production packaging makes no Datadog API requests. Development-server authentication is described above.

### apps.enable

> default: `true` when an `apps` config block is present, `false` otherwise.

Enable or disable the plugin without removing its configuration.

### apps.include

> default: `[]`

Additional glob patterns (relative to the project root) to include in the package. The bundler output directory is always included.

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
