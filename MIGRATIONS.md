# Migrations <!-- #omit in toc -->

Everything you need to know about breaking changes and major version bumps.

<!-- #toc -->
-   [v2 to v3](#v2-to-v3)
    -   [Telemetry Plugin Renamed to Metrics Plugin](#telemetry-plugin-renamed-to-metrics-plugin)
-   [v1 to v2](#v1-to-v2)
    -   [Dependencies](#dependencies)
    -   [Usage](#usage)
    -   [Configuration](#configuration)
    -   [Default filters](#default-filters)
    -   [Log Level](#log-level)
<!-- #toc -->

## v2 to v3

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
        enable: true,
-       output: './metrics-debug',
        enableStaticPrefix: true,
        // ... other configuration
    },
}
```

> [!NOTE]
> The `output` option was previously used for debugging purposes to write metrics to a file. This functionality has been removed from the telemetry plugin in v3 to be later implemented as its own plugin.

#### Helper Changes

The helper path has changed:

```diff
import { helpers } from '@datadog/webpack-plugin';
-const defaultFilters = helpers.telemetry.filters;
+const defaultFilters = helpers.metrics.filters;
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

Supported `site` include: `'datadoghq.com'` (default), `'datadoghq.eu'`, `'us3.datadoghq.com'`, `'us5.datadoghq.com'`, `'ap1.datadoghq.com'`, etc.

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
