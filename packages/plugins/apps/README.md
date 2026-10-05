# Apps Plugin <!-- #omit in toc -->

A Vite plugin that builds a deployable Datadog Apps package. Publishing is owned by `@datadog/apps-cli`.

> [!WARNING]
> The Apps plugin is in **alpha** and is likely to break in most setups.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Backend functions](#backend-functions)
    -   [Backend functions from packages](#backend-functions-from-packages)
-   [Development server authentication](#development-server-authentication)
-   [Package output](#package-output)
    -   [apps.enable](#appsenable)
    -   [apps.include](#appsinclude)
    -   [apps.tags](#appstags)
    -   [apps.longPolling](#appslongpolling)
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
}
```

## Backend functions

Each named export of a `.backend.ts` (or `.tsx`, `.js`, `.jsx`) module in your app is a backend function. The frontend gets a proxy that executes it through Datadog. `vite build` bundles each function on its own into the package. `vite dev` executes it locally through `/__dd/executeAction`. Static checks reject Node built-in imports and network globals such as `fetch` in backend code and the modules it imports. Static `connectionId`s passed to `@datadog/action-catalog` calls become the function's allowed connections.

### Backend functions from packages

A package can ship backend functions too. It opts in from its `package.json`:

```json
{
    "datadogApps": { "backendFunctions": true }
}
```

In an opted-in package, every `.backend.*` module the app imports, directly or through the package's own code, is a backend function exactly like one of the app's. That includes files under `dist/` and imports by the package's own name, such as `@datadog/apps-frontend/visualizations/backend`. The modules it imports from its own package are checked like app code; backend code can only import such a package statically. Under `node_modules`, the package is the installed package root, so a named `package.json` in a subfolder (like `preact/hooks`) doesn't change it.

The opt-in governs packages outside the project root, installed or linked. Code inside the project root is the app's own, even a workspace package with its own `package.json`. A `.backend.*` file in an installed package that hasn't opted in stays an ordinary module, so a dependency can't add functions through its file names. A package linked from outside the project root (a workspace package, `npm link`, a `file:` dependency) that hasn't opted in is the exception: like any linked workspace file, its `.backend.*` files are always proxied, so the build fails, naming the package, rather than deploying them or shipping their bodies.

A few things to know:

-   The plugin logs, at info level in `vite dev` and `vite build`, each package that provides backend functions and the functions it contributes.
-   Declare `@datadog/action-catalog` and `@datadog/apps-backend` as peer dependencies. Each function uses the app's own copy, the one its runtime is set up on. This holds even when the package is linked from a checkout that has its own copy installed.
-   The dev server keeps opted-in packages it finds in the app's dependency tree out of dependency pre-bundling (`optimizeDeps`). Otherwise their backend code would be inlined into the browser bundle. So `vite dev` serves each opted-in package as individual, unbundled modules, even in an app that never calls its backend functions. If pre-bundling still reaches one (an undeclared dependency, an alias), the dev server fails with an error naming the package to add to `optimizeDeps.exclude`.
-   A function's name is derived from its file's path relative to the project root, so it's the same in `vite dev` and `vite build` for a given install, and distinct from every app file's.

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
