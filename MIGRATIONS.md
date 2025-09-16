# Migrations <!-- #omit in toc -->

Everything you need to know about breaking changes and major version bumps.

<!-- #toc -->
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
+       enableStaticPrefix: true,
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
        enableStaticPrefix: true,
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

But we don't want to break existing behavior, so we also added a `enableStaticPrefix` in order not to break existing metrics.

So if you want to keep the previous behavior, and only have your own prefix, use `enableStaticPrefix: false`:

```diff
{
    metrics: {
+       enableStaticPrefix: false,
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
