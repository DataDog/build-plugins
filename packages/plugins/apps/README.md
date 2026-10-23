# Apps Plugin <!-- #omit in toc -->

A Vite plugin that builds a deployable Datadog Apps package. Publishing is owned by `@datadog/apps-cli`.

> [!WARNING]
> The Apps plugin is in **alpha** and is likely to break in most setups.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Development server authentication](#development-server-authentication)
-   [Development server requests](#development-server-requests)
-   [Development server Content Security Policy](#development-server-content-security-policy)
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

## Development server Content Security Policy

The dev server sends its HTML pages and worker scripts with the policy the sandbox shim applies to uploaded apps, as `Content-Security-Policy-Report-Only`: until the shim covers production, it reports what the policy would block and doesn't block it. A policy already on the response, for example from `server.headers`, is kept. The policy would block, among others:

-   classic inline `<script>` elements, `eval` and scripts from another origin;
-   requests to `http:`, `ws:` and `wss:` URLs, and `https:` images;
-   `blob:` workers, frames and form submissions.

Pages Vite transforms log what the policy would block to the browser console, once per rule and URL, with the rule involved. Two things production doesn't need are allowed: the HMR WebSocket in `connect-src`, and, by its hash, the inline React Refresh preamble that `@vitejs/plugin-react` and `@vitejs/plugin-react-swc` inject. The hash is taken from the page when it is sent in one piece and uncompressed, as Vite sends it.

Known gaps:

-   What Vite inlines only in a build, such as a `?worker&inline` worker, isn't covered.
-   Paths under [`server.proxy`](https://vite.dev/config/server-options#server-proxy) are left alone, even when a `bypass` hands the request back to Vite.
-   In middleware mode, HTML from the host server's own routes gets the policy too.
-   On Vite 7 and 8, the client's reconnect check after a dev server restart starts a `blob:` worker, which the logger reports.
-   HTML that another plugin's own dev-server middleware sends isn't covered, since this plugin's middleware runs after normal-order plugins' middlewares.
-   Worker scripts are recognized by their `Sec-Fetch-Dest` request header, which Safari sends from version 16.4.
-   Under Vitest, the policy is off.
-   Tools that serve their own HTML through Vite (`appType: 'custom'`, for example Storybook) aren't covered, since they never run under the sandbox shim.
-   The HMR WebSocket source also admits `http:` requests to the dev server's own host and port.
-   Violations inside a worker, in pages Vite doesn't transform (such as files in `public/`) and in Vite 8's bundled dev mode go only to the browser's own console error.

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
