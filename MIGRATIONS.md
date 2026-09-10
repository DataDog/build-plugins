# Migrations <!-- #omit in toc -->

Everything you need to know about breaking changes and major version bumps.

<!-- #toc -->
-   [v3 to v4](#v3-to-v4)
    -   [`npm run dev` now executes backend functions in-process instead of via a cloud round trip](#npm-run-dev-now-executes-backend-functions-in-process-instead-of-via-a-cloud-round-trip)
    -   [Run `npm run dev:verify` to check cloud parity before publishing](#run-npm-run-devverify-to-check-cloud-parity-before-publishing)
    -   [`process.env` is now allowlisted during local execution](#processenv-is-now-allowlisted-during-local-execution)
    -   [Custom Credentials resolve locally via `datadog-app.local.json`](#custom-credentials-resolve-locally-via-datadog-applocaljson)
    -   [`getInitiatingUser()` and `getExecutionUser()` continue to return your real identity locally](#getinitiatinguser-and-getexecutionuser-continue-to-return-your-real-identity-locally)
-   [v2 to v3](#v2-to-v3)
    -   [Renamed `disabled` to `enable`](#renamed-disabled-to-enable)
    -   [Removed `options.errorTracking.sourcemaps.disableGit`](#removed-optionserrortrackingsourcemapsdisablegit)
    -   [Renamed `cwd` to `buildRoot`](#renamed-cwd-to-buildroot)
    -   [Telemetry Plugin Renamed to Metrics Plugin](#telemetry-plugin-renamed-to-metrics-plugin)
    -   [Unified `site` Configuration](#unified-site-configuration)
-   [v1 to v2](#v1-to-v2)
    -   [Dependencies](#dependencies)
    -   [Usage](#usage)
    -   [Configuration](#configuration)
    -   [Default filters](#default-filters)
    -   [Log Level](#log-level)
<!-- #toc -->

## v3 to v4

This release changes how `npm run dev` runs an app's backend functions (`*.backend.ts`). Apps that don't define any backend functions are unaffected.

### `npm run dev` now executes backend functions in-process instead of via a cloud round trip

Previously, `npm run dev` bundled a backend function's file and sent it to Datadog's API on every call, executing it in the cloud and returning the result over the network.

`npm run dev` now loads the function's file directly into the local Vite dev server and executes it there, instead of bundling it and sending it to the cloud on every call. `$.Actions` calls still reach Datadog's API exactly as they do in production, and connection scoping and input/output validation behave the same as before — a function that only reads its arguments and calls `$.Actions` needs no changes.

Static imports of Node built-ins (`fs`, `child_process`, `net`, etc.), dynamic imports of one using a literal string specifier (e.g. `import('fs')`), and raw network globals (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`) in a backend file are rejected at build time — this check covers every app-local module resolved into the backend bundle, not just the entry file itself, so an app-local helper module is checked too. A dynamic import using a runtime-computed specifier (e.g. `import(moduleName)`) isn't caught by this check. Backend functions have never had access to these in production, and `npm run dev` ran a function through that same restricted production environment before this release too (see above) — so code relying on one of these already failed under `npm run dev`, just later than it does now, and with a runtime error instead of this build-time one.

A separate runtime guard also blocks network and subprocess access (`net`, `dns`, `child_process`, `worker_threads`, etc.) once a function body starts running, except `dns.lookup()` — unlike `dns.resolve()` and its variants, it stays available locally, since blocking it risks breaking hostname validation used well outside any exfiltration path. The guard exists for what the build-time check above can't see: a `node_modules` dependency that reaches the network or spawns a process directly from inside the function body — bypassing `$.Actions` — fails at call time under `npm run dev` instead of at build time. It doesn't cover a dependency's own top-level initialization code, which runs while the module loads, before the guard is in scope; because Vite then caches that evaluation for the backend file and its app-local helpers too, not just a dependency, module-scoped state (a counter, a singleton, a cached result) persists across every later call instead of resetting the way the old cloud round trip did on each request. Calls to different backend functions are also serialized rather than run concurrently — every local execution goes through one queue to protect shared `$` access — so a slow call can visibly delay an unrelated fast one in a way production's independently-dispatched requests never would. `npm run dev:verify` is what catches all of this before publishing.

### Run `npm run dev:verify` to check cloud parity before publishing

Because a function's own code now runs locally instead of in Datadog's cloud, local execution can no longer catch every difference between local and production behavior on its own (see the `process.env` allowlist below, for example).

`npm run dev:verify` still executes backend functions through the full cloud round trip, the same way `npm run dev` used to. Run it before publishing an app to confirm a function's real dependencies (environment variables, connections) behave the same way in the cloud as they did locally.

```bash
npm run dev:verify
```

If your `package.json` doesn't have a `dev:verify` script yet, `dev:verify` is just your existing dev command with Vite's `--mode dev-verify` flag appended (e.g. `vite --mode dev-verify`) — add the script, or run the equivalent command directly.

### `process.env` is now allowlisted during local execution

A backend function running under `npm run dev` no longer has unscoped access to `process.env`. It's scoped to a small, fixed set of safe variables during local execution: `PATH`, `HOME`, `NODE_ENV`, and `TMPDIR`.

Reading any other variable — including one a secret-backed connection would resolve to in production — returns `undefined` locally, even though the equivalent read against the deployed function succeeds in production. The one exception is a Custom Credentials-backed variable declared in `datadog-app.local.json` (see below).

```diff
 export function myBackendFunction() {
-    const region = process.env.AWS_REGION; // resolved in production
+    const region = process.env.AWS_REGION; // undefined under `npm run dev` — not in the local allowlist
 }
```

If a backend function depends on a variable like this, verify it with `npm run dev:verify` (see above) before publishing, since that path still runs against the real cloud environment.

### Custom Credentials resolve locally via `datadog-app.local.json`

Previously, a backend function's Custom Credentials-backed connection resolved to its real value under `npm run dev`, because the function ran through the cloud round trip described above. Now that the function runs locally, that same variable would otherwise fall under the allowlist above and read as `undefined`.

`npm run dev` closes that gap by resolving Custom Credentials from a `datadog-app.local.json` file in your project root, if you create one. Add it to `.gitignore` and map each credential's env var name to its real value:

```json
{
    "STRIPE_API_KEY": "sk_test_..."
}
```

A missing file resolves to no extra variables — most projects won't have one, and the variable then reads as `undefined` locally until you add it. A present-but-malformed file (invalid JSON, or a value that isn't a string) throws instead of silently resolving to `undefined`, so a typo doesn't look identical to an undeclared secret.

A `datadog-app.local.json` entry resolves before the function's module finishes loading, so a client constructed at the module's top level sees the real value too, the same as one constructed inside the function body:

```ts
const client = new StripeClient(process.env.STRIPE_API_KEY); // real value, once declared in datadog-app.local.json

export function myBackendFunction() {
    // ...
}
```

### `getInitiatingUser()` and `getExecutionUser()` continue to return your real identity locally

Previously, `getInitiatingUser()` and `getExecutionUser()` (from `@datadog/apps-backend/user`) returned your real identity under `npm run dev`, because the function ran through the cloud round trip described above and `$.Source` came from that same authenticated session.

Now that the function runs locally, `npm run dev` fetches your real, authenticated identity from a preview call before running any backend code, so `getInitiatingUser()` and `getExecutionUser()` keep returning that real identity (`id`, `orgId`, and optionally `email` and `name`) instead of falling back to a placeholder.

Both calls return the identity of that preview invocation, i.e. your own account — not necessarily the identity a real deployed trigger would pass to `getExecutionUser()` (a scheduled run or a different end user's action, for example). `npm run dev:verify` doesn't help here either — it's also a manual preview under your own credentials, with no way to simulate another trigger's identity. Confirm behavior against an execution's real identity by publishing the app and running it through an actual deployed trigger instead.

## v2 to v3

To sum up, here's the complete migration (to adapt for other bundlers) :

```diff
// Renamed `telemetry` to `metrics`
-import type { TelemetryTypes } from '@datadog/webpack-plugin';
-type MyOptions = TelemetryTypes.TelemetryOptions;
+import type { MetricsTypes } from '@datadog/webpack-plugin';
+type MyOptions = MetricsTypes.MetricsOptions;

import { datadogWebpackPlugin, helpers } from '@datadog/webpack-plugin';
// Renamed `telemetry` to `metrics`
-const defaultFilters = helpers.telemetry.filters;
+const defaultFilters = helpers.metrics.filters;

const myFilter = (metric: Metric): Metric | null => {
    // New API
-   const value = metric.value;
+   const value = metric.points[0]?.[1] || 0;
    return value > 100 ? metric : null;
};

const plugin = datadogWebpackPlugin({
    auth: {
        apiKey: '<my-api-key>',
        // Centralized `site` configuration
+       site: 'datadoghq.eu'
    },
    // Removed `disableGit` option in favor of `enableGit`
+   enableGit: false,
    // Renamed `telemetry` to `metrics`
-   telemetry: {
+   metrics: {
        // Renamed `disabled` to `enable`
-       disabled: true,
+       enable: false,
        // Centralized `site` configuration
-       endPoint: 'https://app.datadoghq.eu'
        // New `output` plugin
-       output: './metrics-debug',
        // Default static prefix
+       enableDefaultPrefix: true,
        filters: [...defaultFilters, myFilter],
        // ... other configuration
    },
    errorTracking: {
        sourcemaps: {
            // Centralized `site` configuration
-           intakeUrl: 'https://sourcemap-intake.datadoghq.eu/api/v2/srcmap',
            // Removed `disableGit` option in favor of root's `enableGit`
-           disableGit: true,
            // ... other options
        }
    },
    // New `output` plugin
+   output: {
+       path: './metrics-debug',
+       files: {
+           metrics: true,
+       },
+   }
});
```

### Renamed `disabled` to `enable`

We renamed all the usages of `disabled` in the configuration to now use `enable` instead.

```diff
{
-   disableGit: true,
+   enableGit: false,
    metrics: {
-       disabled: false,
+       enable: true,
    },
}
```

### Removed `options.errorTracking.sourcemaps.disableGit`

In favor of `options.enableGit`.

```diff
{
-   disableGit: true,
+   enableGit: false,
    errorTracking: {
        sourcemaps: {
-           disableGit: true,
        },
    },
}
```

### Renamed `cwd` to `buildRoot`

We renamed the `cwd` hook into `buildRoot` to better represent what it actually is.

```diff
{
    customPlugins: ({ context }) => {
-       const buildRoot = context.cwd;
+       const buildRoot = context.buildRoot;
        return [{
            name: 'my-custom-plugin',
-           cwd(cwd: string) {
+           buildRoot(buildRoot: string) {
                // Build root ready to use.
            },
        }];
    },
}
```

### Telemetry Plugin Renamed to Metrics Plugin

The telemetry plugin has been renamed to metrics plugin to better reflect its purpose.

#### Configuration Changes

The configuration key has changed from `telemetry` to `metrics` and the `output` option has been removed from the metrics plugin configuration:

```diff
{
    auth: {
        apiKey: '<my-api-key>',
    },
-   telemetry: {
+   metrics: {
-       output: './metrics-debug',
        enableDefaultPrefix: true,
        // ... other configuration
    },
+   output: {
+       path: './metrics-debug',
+       files: {
+           metrics: true,
+       }
+   },
}
```

> [!NOTE]
> The `output` option was previously used for debugging purposes to write metrics to a file. This functionality has been removed from the telemetry plugin in v3 to be later implemented as its own plugin.

#### Default Static Prefix

We want all the metrics to be prefixed by `build.<bundler>.`.

But we don't want to break existing behavior, so we also added a `enableDefaultPrefix` in order not to break existing metrics.

So if you want to keep the previous behavior, and only have your own prefix, use `enableDefaultPrefix: false`:

```diff
{
    metrics: {
+       enableDefaultPrefix: false,
        prefix: 'my.prefix',
    },
}
```

#### Helper Changes

The helper path has changed:

```diff
import { helpers } from '@datadog/webpack-plugin';
-const defaultFilters = helpers.telemetry.filters;
+const defaultFilters = helpers.metrics.filters;
```

#### Filters API Changes

Now filters use the correct `Metric` object. It only changes the `value` property and replaces it with the `points` property.

Following what we have in our APIs.

```diff
const myFilter = (metric: Metric): Metric | null => {
    // New API
-   const value = metric.value;
+   const value = metric.points[0]?.[1] || 0;
    return value > 100 ? metric : null;
};
```

#### Type Changes

If you're using TypeScript, the type names have changed:

```diff
-import type { TelemetryTypes } from '@datadog/webpack-plugin';
-type MyOptions = TelemetryTypes.TelemetryOptions;
+import type { MetricsTypes } from '@datadog/webpack-plugin';
+type MyOptions = MetricsTypes.MetricsOptions;
```

### Unified `site` Configuration

The Datadog site configuration has been unified under `auth.site`.<br/>
This replaces the individual endpoint configurations at the product level.

- `telemetry.endPoint` - Now derived from `auth.site`
- `errorTracking.sourcemaps.intakeUrl` - Now derived from `auth.site`

```diff
{
    auth: {
        apiKey: 'xxx'
+       site: 'datadoghq.eu'
    },
    telemetry: {
-       endPoint: 'https://app.datadoghq.eu'
    },
    errorTracking: {
        sourcemaps: {
-           intakeUrl: 'https://sourcemap-intake.datadoghq.eu/api/v2/srcmap',
            // ... other options
        }
    }
}
```

Supported `site` include: `'datadoghq.com'` (default), `'datadoghq.eu'`, `'us3.datadoghq.com'`, `'us5.datadoghq.com'`, `'ap1.datadoghq.com'`, etc. You can also prefix any of these with a custom subdomain (e.g. `'myorg.us5.datadoghq.com'`) if your organization uses a custom Datadog URL.

> [!NOTE]
> - You can still use `DATADOG_SOURCEMAP_INTAKE_URL` to override the sourcemaps' intake url.
> - The `DATADOG_SITE` environment variable takes priority over the `auth.site` configuration, allowing you to override the site at runtime without changing your configuration files.

## v1 to v2

This is a major rewrite of the whole project.<br/>
In short, we are now publishing each plugin individually.

### Dependencies

We changed the name of the packages we publish.<br/>
No more generic `@datadog/build-plugin` packages, but instead one package per bundler.

```diff
"devDependencies": {
-    "@datadog/build-plugin": "1.0.4",
+    "@datadog/esbuild-plugin": "2.0.0",
+    "@datadog/webpack-plugin": "2.0.0",
}
```

### Usage

We changed how you import and instantiate the plugin in your code.

#### ESBuild

```diff
-import { BuildPlugin } from '@datadog/build-plugin/dist/esbuild';
+import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import esbuild from 'esbuild';

esbuild
    .build({
        plugins: [
-           new BuildPlugin({
+           datadogEsbuildPlugin({
                // Your configuration here.
            }),
        ],
    })

```

#### Webpack

```diff
// webpack.config.js
-import { BuildPlugin } from '@datadog/build-plugin/dist/webpack';
+import { datadogWebpackPlugin } from '@datadog/webpack-plugin';

const config = {
    plugins: [
-       new BuildPlugin({
+       datadogWebpackPlugin({
            // Your configuration here.
        }),
    ]
};

export default config;

```

### Configuration

We changed a bit how the configuration goes:<br/>
Now, each plugin has its own configuration object, and no more `datadog` key.<br/>
And we moved the `apiKey` to the `auth` key.

```diff
{
+    auth: {
+        apiKey: '<my-api-key>',
+    },
+    telemetry: {
         disabled: false,
         output: './esbuild-profile-debug',
-        datadog: {
-            apiKey: '<my-api-key>',
         prefix: 'my.prefix',
         [...]
-        },
+    },
}
```

### Default filters

We expose the default filters in each bundler's package.

```diff
-import { defaultFilters } from '@datadog/build-plugin/dist/hooks/datadog/helpers';
+import { helpers } from '@datadog/webpack-plugin';
+const defaultFilters = helpers.telemetry.filters;
```

### Log Level

We added a new configuration point to better control the logs.<br/>
Before that, the default was `debug`, but with this new setting, the default is `warn`.<br/>
To keep the same behavior as before:

```diff
{
    auth: {
        [...]
    },
+   logLevel: 'debug',
    telemetry: {
         [...]
    },
}
```
