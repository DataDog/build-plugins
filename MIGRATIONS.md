# Migrations

Everything you need to know about breaking changes and major version bumps.

## v1 to v2

This is a major rewrite of the whole project.

In short, we are now publishing each plugin individually.

### Dependencies

We changed the name of the packages we publish.

No more generic `@datadog/build-plugin` packages, but instead one package per bundler.

```diff
"devDependencies": {
-    "@datadog/build-plugin": "1.0.4",
+    "@datadog/esbuild-plugin": "2.0.0",
+    "@datadog/webpack-plugin": "2.0.0",
+    "@datadog/build-plugins-core": "2.0.0",
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
-            new BuildPlugin({
+            datadogEsbuildPlugin({
                // Your configuration here.
            }),
        ],
    })

```

#### Webpack

```diff
-import { BuildPlugin } from '@datadog/build-plugin/dist/esbuild';
+import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import esbuild from 'esbuild';

esbuild
    .build({
        plugins: [
-            new BuildPlugin({
+            datadogEsbuildPlugin({
                // Your configuration here.
            }),
        ],
    })

```

### Configuration

We changed a bit how the configuration goes:

```diff
{
+    auth: {
+        apiKey: '<my-api-key>',
+    },
+    telemetry: {
         disabled: false,
         output: './esbuild-profile-debug',
         datadog: {
-            apiKey: '<my-api-key>',
             prefix: 'my.prefix',
             [...]
         },
         [...]
+    },
}
```

### Default filters

We removed the default filters from the plugins and use a separate package to expose them now:

```diff
-import { defaultFilters } from '@datadog/build-plugin/dist/hooks/datadog/helpers';
+import { defaultTelemetryFilters } from '@datadog/build-plugins-core';
```
