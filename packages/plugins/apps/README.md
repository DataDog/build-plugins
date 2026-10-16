# Apps Plugin <!-- #omit in toc -->

A Vite plugin that builds a deployable Datadog Apps package. Publishing is owned by `@datadog/apps-cli`.

> [!WARNING]
> The Apps plugin is in **alpha** and is likely to break in most setups.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Development server authentication](#development-server-authentication)
-   [Development server requests](#development-server-requests)
-   [Backend function runtime](#backend-function-runtime)
-   [Package output](#package-output)
    -   [apps.enable](#appsenable)
    -   [apps.include](#appsinclude)
    -   [apps.tags](#appstags)
    -   [apps.longPolling](#appslongpolling)
    -   [apps.parameters](#appsparameters)
<!-- #toc -->

## Configuration

```ts
apps?: {
    enable?: boolean;
    include?: string[];
    tags?: string[];
    longPolling?: {
        maxRetries?: number;
        jitter?: boolean;
        exponentialBackoff?: boolean;
        timeoutMs?: number;
    };
    parameters?: ReturnType<typeof defineDatadogAppParameters>;
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

## Development server requests

The dev server's backend function endpoints (`/__dd/executeAction`, `/__dd/executeActionViaCloud` and `/__dd/debugBundle`) accept a `POST` only when:

-   its `Host` passes Vite's [`server.allowedHosts`](https://vite.dev/config/server-options#server-allowedhosts) check, which Vite skips when `server.https` is set or `server.allowedHosts` is `true`;
-   its `Origin`, when sent, names the same host and port as its `Host`;
-   its body is sent with `Content-Type: application/json`.

To call one by hand, send that content type, for example `curl -X POST -H 'Content-Type: application/json' -d '{"functionName":"..."}' http://localhost:5173/__dd/debugBundle`.

## Backend function runtime

The plugin applies the rules of the backend runtime your org's backend functions run on in Datadog: the Node backend runtime (v2) or the Deno backend runtime (v1). It looks the org's runtime up once per process for each set of credentials: the API keys every Datadog build plugin uses (`DD_API_KEY`/`DD_APP_KEY`, else the `auth.apiKey`/`auth.appKey` options), else the OAuth token above. Without credentials it assumes v1. When the lookup fails, it warns and applies the stricter v1 checks. A build keeps one lookup's result throughout, while a dev server or a later watch-mode build tries again the next time the runtime is needed, a minute later at the earliest. Meanwhile, a rejection v2 wouldn't make says the org's runtime couldn't be determined.

Under v2 (Node), backend functions may import Node built-ins and use Node's network globals such as `fetch` and `WebSocket`, but not `XMLHttpRequest`, `EventSource` or `Deno`, which Node doesn't expose by default. The `crypto`/`Intl` warning is replaced by one for `process.env` reads: in production, the Node backend runtime (v2) doesn't pass your own environment variables or Custom Credentials to backend functions, so those reads don't see the values they see in local dev. The check skips modules a backend file imports from `node_modules` or from outside the Vite root, so an SDK that reads `process.env` (for example, for a default API key) doesn't warn; a `.backend.*` file is checked even outside the Vite root, unless it's under `node_modules` or `.yarn`, or in the build's output directory. Cloud execution and its bundles (`dev:verify`, `/__dd/executeActionViaCloud`, `/__dd/debugBundle`) follow the same runtime.

## Package output

A production `vite build` writes `datadog-app-assets.zip` beside the Vite output. The ZIP contains `frontend/`, `backend/`, and `manifest.json`. The app's identity is resolved by `@datadog/apps-cli` at deploy time.

Set `DATADOG_APPS_PACKAGE_DIR` (or `DD_APPS_PACKAGE_DIR`) to write the archive to a different directory.

Use `datadog-apps build` to package locally, and `datadog-apps upload` to build, upload and publish. Production packaging makes no Datadog API requests beyond the runtime lookup above. Development-server authentication is described above.

### apps.enable

> default: `true` when an `apps` config block is present, `false` otherwise.

Enable or disable the plugin without removing its configuration.

### apps.include

> default: `[]`

Additional glob patterns (relative to the project root) to include in the package. The bundler output directory is always included.

### apps.tags

> default: none

Tags to add to the app, e.g. `['team:my-team']`. Tags are trimmed and lowercased. Datadog applies its remaining tag rules on upload (for example, a tag must start with a letter) and drops tags that don't pass them. Tags never fail a build: entries that aren't non-empty strings are skipped with a warning.

The package's `manifest.json` carries the app's tags: these tags plus one `surface:<id>` tag for each surface declared by an `@datadog/apps-frontend` input the built frontend uses (for example `surface:datadog.dashboard`), letting product surfaces find apps meant for them. Surface tags are derived from the final bundle, so an input that is imported but tree-shaken away adds none, and an input offered on every surface (like the theme) adds none either.

Deploying adds these tags to the app. It never removes tags, so tags added in the App Builder UI survive the next deploy. Removing a tag is done in the UI, and a tag removed from `apps.tags`, or a surface whose input the app stopped using, stays on the app until someone removes it there.

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

### apps.parameters

> default: discovered from app code

Production builds read every `defineDatadogAppParameters({...})` call from `@datadog/apps-frontend/parameters` in the app's source, merge them, and write the result to `manifest.json` as `inputSchema.parameters`. Each upload stores it on the new app version, and a build that finds none clears any earlier declaration. Import the function by name, renamed, or through a namespace import, and call it directly with an object literal. Import it with the literal `@datadog/apps-frontend/parameters` specifier, not through a bundler alias or a tsconfig path. A declaration the build cannot read literally (variables, spreads, re-exports, dynamic imports, aliased imports, calling the function through another variable) fails the build, as does one parameter declared differently in two places, more than 50 parameters, or a declaration outside the app's own source (another package, or `node_modules`).

Set `apps.parameters` to a `defineDatadogAppParameters()` result only to override discovery.
