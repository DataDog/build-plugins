# Apps Plugin <!-- #omit in toc -->

A Vite plugin that builds a deployable Datadog Apps package. Publishing is owned by `@datadog/apps-cli`.

It needs Vite 6.4 or later: on an older Vite, it stops every Vite command with an upgrade hint.

> [!WARNING]
> The Apps plugin is in **alpha** and is likely to break in most setups.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Backend functions](#backend-functions)
    -   [Backend functions from packages](#backend-functions-from-packages)
-   [Development server authentication](#development-server-authentication)
-   [Development server requests](#development-server-requests)
-   [Cloud execution](#cloud-execution)
-   [Local execution](#local-execution)
-   [Backend function runtime](#backend-function-runtime)
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

## Backend functions

Each named export of a `.backend.ts` (or `.tsx`, `.js`, `.jsx`) module in your app is a backend function. The frontend gets a proxy that executes it through Datadog. `vite build` bundles each function on its own into the package. `vite dev` executes it locally through `/__dd/executeAction`. Static checks reject globals the [Node backend runtime](#backend-function-runtime) lacks in backend code and the modules it imports. Static `connectionId`s passed to `@datadog/action-catalog` calls become the function's allowed connections.

### Backend functions from packages

A package can ship backend functions too. It opts in from its `package.json`:

```json
{
    "datadogApps": { "backendFunctions": true }
}
```

In an opted-in package, every `.backend.*` module the app imports, directly or through the package's own code, is a backend function exactly like one of the app's. That includes files under `dist/` and imports by the package's own name, such as `@datadog/apps-frontend/visualizations/backend`. The modules it imports from its own package are checked like app code; backend code can only import such a package statically. Under `node_modules`, the package is the installed package root, so a named `package.json` in a subfolder (like `preact/hooks`) doesn't change it.

The opt-in governs installed packages (under `node_modules`) and packages linked from outside the project root. Other code inside the project root is the app's own, even a workspace package with its own `package.json`. A `.backend.*` file in an installed package that hasn't opted in stays an ordinary module, so a dependency can't add functions through its file names. A package linked from outside the project root (a workspace package, `npm link`, a `file:` dependency) that hasn't opted in is the exception: like any linked workspace file, its `.backend.*` files are always proxied, so the build fails, with an error naming the opt-in, rather than deploying them or shipping their bodies.

A few things to know:

-   When `vite dev` starts, the plugin logs, at info level, each package that provides backend functions. `vite build` logs each function a package contributes to the app's package.
-   Declare `@datadog/action-catalog` and `@datadog/apps-backend` as peer dependencies. Each function uses the app's own copy, the one its runtime is set up on. This holds even when the package is linked from a checkout that has its own copy installed.
-   The dev server keeps opted-in packages it finds in the app's dependency tree out of dependency pre-bundling (`optimizeDeps`). Otherwise their backend code would be inlined into the browser bundle. So `vite dev` serves each opted-in package as individual, unbundled modules, even in an app that never calls its backend functions. Every name the package is installed under counts, npm aliases included. A package it doesn't find there (an undeclared dependency) needs adding to `optimizeDeps.exclude` by hand; the plugin then treats it like one it found. `vite build` never pre-bundles.
-   A function's name is derived from its file's path relative to the project root, so it's the same in `vite dev` and `vite build` for a given install, and distinct from every app file's. It changes when the install path does, as it can when the package's version changes under pnpm.

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

The dev server warns once for each distinct refusal and logs repeats at `debug`. Past a per-server cap, it warns once more to say so, then logs new refusals at `debug` too.

To call one by hand, send that content type, for example `curl -X POST -H 'Content-Type: application/json' -d '{"functionName":"..."}' http://localhost:5173/__dd/debugBundle`.

## Cloud execution

Cloud execution (`dev:verify`, `/__dd/executeActionViaCloud`) bundles a backend function with the production settings a `vite build` upload gets, though the dev server runs under `NODE_ENV=development`, so it sends the bytes an upload would; `/__dd/debugBundle` returns that bundle, minified with names kept. Vite's stub for an optional peer dependency the app hasn't installed still follows the dev server's `NODE_ENV`.

When Datadog rejects a bundle as longer than the `jsFunctionWithActions` `script` input accepts, the dev server answers with a 413 naming the function, its size and Datadog's answer, and warns once per function until the dev server restarts.

## Local execution

`/__dd/executeAction` runs each backend function call the way production does: in a fresh Node process of its own, in parallel with other calls.

-   **Fresh state**: module-level variables and globals start over on every call.
-   **Concurrency**: calls run in parallel, with no local limit, so a large burst starts that many processes. Production's concurrency limits vary by org, and `dev:verify` runs against them. A call that starts while another call's runtime context (`$`) query is in flight shares that query instead of sending its own.
-   **Timeout**: a call that runs past its time budget is killed, even inside a synchronous loop.
-   **Sandbox**: Node's [permission model](https://nodejs.org/api/permissions.html) lets a call read the project, its `node_modules` folders and the packages linked from them, Vite and Vite's [`server.fs.allow`](https://vite.dev/config/server-options#server-fs-allow) folders, and write only to its own temp dir (`os.tmpdir()`), which is also its working directory, and `/tmp`, so a project inside `/tmp` is writable too. A refused read or write throws `ERR_ACCESS_DENIED`, not `ENOENT`, so code that tolerates only a missing file fails locally. Modules loaded through Vite, though not `fs` reads or a native `require`, refuse files matching Vite's [`server.fs.deny`](https://vite.dev/config/server-options#server-fs-deny), such as `.env`, and, unless `server.fs.strict` is `false`, files outside those folders. It refuses subprocesses, worker threads and native addons, allows the network, and caps the heap at 256 MB. A refusal the function lets reach its result fails the call with a message that points to `dev:verify`, since production may allow it, and names the path for a file refusal, or Node's reason for an API that needs full access, such as `fs.symlink` on Node 24. On a Node without [`module.registerHooks`](https://nodejs.org/api/module.html#moduleregisterhooksoptions), added in Node 22.15, modules get no `import.meta.resolve`, which Vite resolves on a worker thread there, and the dev server warns once. A known gap, from Node's [documented limitations](https://nodejs.org/api/permissions.html#limitations-and-known-issues): "Symbolic links will be followed even to locations outside of the set of paths that access has been granted to." Here, a symlink in a writable folder (the call's temp dir or `/tmp`) lets a call read or write wherever it points, project files included. Local execution is a parity aid, not a security boundary.
-   **Environment**: a call sees no variables from the dev server's environment, keys included, except Node's TLS and time zone settings (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `TZ`), plus `SystemRoot` on Windows, and no Node options from `NODE_OPTIONS`. Vite still inlines `import.meta.env` and `define` values into the code it serves. `$.Actions` calls go back to the dev server, which holds the credentials and checks each call's connection against the function's allowed connections.
-   **Logs**: a call's `stdout` and `stderr` reach the dev server's terminal line by line, each prefixed with its call, for example `[getGreeting#3]`.
-   **Debugging**: when the dev server runs under a debugger (`--inspect`), each call's process listens on a random local port and prints its `Debugger listening on ws://…` URL with its prefix. Attach to that URL to debug the call; calls don't time out while the dev server is under a debugger.
-   **Older Node**: on a Node without the permission model, or without `--allow-inspector` while debugging, a call's process runs unrestricted, and the dev server warns once that production's limits aren't enforced locally.

Local execution doesn't support Yarn Plug'n'Play, whose packages load through hooks a call's process doesn't get: each call fails with a hint to set `nodeLinker: node-modules` or use `dev:verify`.

## Backend function runtime

Backend functions run on the Node backend runtime, and the plugin's build-time and dev-server checks follow its rules: backend functions may import Node built-ins and use Node's network globals such as `fetch` and `WebSocket`, but not `XMLHttpRequest`, `EventSource` or `Deno`, which Node doesn't expose by default. The checks fail only where the missing global would throw: any bare use but `typeof Deno`, or using `globalThis.Deno` as an object, function or class, even after a feature check or a polyfill install, so use an imported polyfill by its name. Feature checks such as `if (globalThis.EventSource)` and destructuring defaults pass. The checks follow a binding the global is declared or destructured into, but not a plain assignment such as `d = globalThis.Deno`, a `let` or parameter alias of `globalThis`, a bulk copy such as `{ ...globalThis }`, or a value that is stored in an object, array or class field, exported, returned or passed on. Local execution runs on your own Node, while the Node backend runtime runs Node 24, so the dev server warns once at start on another major version, and on one before Node 22, which lacks the global `WebSocket`.

The checks also warn, without failing the build, about `process.env` reads: in production, the Node backend runtime doesn't pass your own environment variables or Custom Credentials to backend functions, so those reads don't see your values there. They catch direct reads: `process.env.X`, `process.env[key]`, a destructure of `process.env`, an `env`, default or namespace import from `process` or `node:process`, and a `const` bound to `process.env` or to an `env` destructured from `process`. Like the other checks, they cover only the app's own code and opted-in packages, so an SDK that reads `process.env` (for example, for a default API key) doesn't warn.

## Development server Content Security Policy

The dev server sends its HTML pages and worker scripts with the policy the sandbox shim applies to uploaded apps, as `Content-Security-Policy-Report-Only`: until the shim covers production, it reports what the policy would block and doesn't block it. A policy already on the response, for example from `server.headers`, is kept. The policy would block, among others:

-   classic inline `<script>` elements, `eval` and scripts from another origin;
-   requests to `http:`, `ws:` and `wss:` URLs, and `https:` images;
-   `blob:` workers, frames and form submissions.

Pages Vite transforms log what the policy would block to the browser console, once per rule and URL, with the rule involved. Two things production doesn't need are allowed: the HMR WebSocket in `connect-src`, and, by its hash, the inline React Refresh preamble that `@vitejs/plugin-react` and `@vitejs/plugin-react-swc` inject. The hash is taken from the page when its whole uncompressed body goes to `res.end()`, as Vite sends it.

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
