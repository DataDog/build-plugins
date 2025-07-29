# Metrics Plugin <!-- #omit in toc -->

Display and send metrics to Datadog.

<!-- The title and the following line will both be added to the root README.md with yarn cli integrity  -->

![Yarn's build-plugin output](/packages/assets/src/build-plugin-output.png)

> [Yarn](https://github.com/yarnpkg/berry)'s build-plugin output.

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
    -   [`enable`](#enable)
    -   [`enableStaticPrefix`](#enablestaticprefix)
    -   [`enableTracing`](#enabletracing)
    -   [`endPoint`](#endpoint)
    -   [`output`](#output)
    -   [`prefix`](#prefix)
    -   [`tags`](#tags)
    -   [`timestamp`](#timestamp)
    -   [`filters`](#filters)
-   [Metrics](#metrics)
-   [Dashboard](#dashboard)
<!-- #toc -->

## Configuration

```ts
metrics?: {
    enable?: boolean;
    enableStaticPrefix?: boolean;
    enableTracing?: boolean;
    endPoint?: string;
    output?: boolean
        | string
        | {
            destination: string;
            timings?: boolean;
            metrics?: boolean;
        };
    prefix?: string;
    tags?: string[];
    timestamp?: number;
    filters?: ((metric: Metric) => Metric | null)[];
}
```

### `enable`

> default: `true`

Plugin will be enabled and track metrics when set to `true`.

### `enableStaticPrefix`

> default: `true`

When set to `true` (the default), the automatic `build.<bundler>.` prefix will be added to metrics.

Set to `false` to disable this prefix and have full control over metric naming.

### `enableTracing`

> default: `false`

If `true`, it will add tracing data to the metrics.

But it is way more time consuming on the build.

And only supports <img src="/packages/assets/src/webpack.svg" alt="Webpack" width="17" /> Webpack and <img src="/packages/assets/src/esbuild.svg" alt="Esbuild" width="17" /> Esbuild (for now).

### `endPoint`

> default: `"app.datadoghq.com"`

To which endpoint will the metrics be sent.

### `output`

> default: `true`

If `true`, you'll get the creation of both json files:
-   `metrics.json`: an array of all the metrics that would be sent to Datadog.
-   `timings.json`: timing data for modules, loaders and plugins.

If a path, it will save the files at this location.

You can also pass an object of the form:

```javascript
{
    destination: 'path/to/destination',
    timings: true,
    metrics: false,
}
```

To only output a specific file.

### `prefix`

> default: `""`

Add a custom prefix to all the metrics sent.

Note that all metrics will automatically have a `build.<bundler>.` prefix prepended (e.g., `build.webpack.`) unless `enableStaticPrefix` is set to `false`.

### `tags`

> default: `[]`

An array of tags to apply to all metrics.

### `timestamp`

> default: `Date.now()`

Which timestamp to use when submitting your metrics.

### `filters`

> default: [`[ filterTreeMetrics, filterSourcemapsAndNodeModules, filterMetricsOnThreshold ]`](/packages/plugins/metrics/src/common/filters.ts)

You can add as many filters as you want. They are just functions getting the `metric` as an argument.

```ts
Metric {
    metric: string; // Name of the metric.
    type: 'count' | 'size' | 'duration';
    value: number;
    tags: string[];
}
```

The filter should return the metric (_with modifications if necessary_) to include it,
or return `null` to remove it.

It is a good way to filter out what you don't want to send.<br/>
We're adding a few default filters in order to reduce the noise.<br/>
When adding your own filters, it will remove these default filters.<br/>
You can still use them if you wish.

For example if you want to clean the assets' names, you can add this filter:

```javascript
import { datadogWebpackPlugin, helpers } from '@datadog/webpack-plugin';

const defaultFilters = helpers.metrics.filters;

datadogWebpackPlugin({
    auth: {
        apiKey: '<my-api-key>',
    },
    metrics: {
        filters: [
            // Keep the default filters.
            ...defaultFilters,
            // Add a new filter to clean asset names.
            (metric) => {
                metric.tags = metric.tags.map((t) => {
                    if (/^assetName:/.test(t)) {
                        const newAssetName = t
                            .split('/')
                            // Only keep the name of the file.
                            .pop()
                            // Remove the hash from the name.
                            .replace(/(\.|-)[0-9a-f]{6,32}/, '');
                        return `assetName:${newAssetName}`;
                    }
                    return t;
                });
                return metric;
            },
        ],
    },
});
```

## Metrics

> [!CAUTION]
> Please note that this plugin can generate a lot of metrics, you can greatly reduce their number by tweaking the [`datadog.filters`](#filters).

> [!NOTE]
> As of v3, all metrics are automatically prefixed with `build.<bundler>.` (e.g., `build.webpack.`, `build.esbuild.`, etc.) by default. You can disable this by setting `enableStaticPrefix: false` in the configuration.

Here's the list of the metrics that are computed by default:

| Metric                                       | Tags                                                                             | Type         | Description                                            |
| :------------------------------------------- | :------------------------------------------------------------                    | :----------- | :----------------------------------------------------- |
| `build.${bundler}.${prefix}.assets.count`            | `[]`                                                                             | count        | Number of assets.                                      |
| `build.${bundler}.${prefix}.assets.size`             | `[assetName:${name}, assetType:${type}, entryName:${name}]`                      | bytes        | Size of an asset file.                                 |
| `build.${bundler}.${prefix}.assets.modules.count`    | `[assetName:${name}, assetType:${type}, entryName:${name}]`                      | count        | Number of modules in a chunk.                          |
| `build.${bundler}.${prefix}.compilation.duration`    | `[]`                                                                             | milliseconds | Duration of the build.                                 |
| `build.${bundler}.${prefix}.entries.assets.count`    | `[entryName:${name}]`                                                            | count        | Number of assets from an entry.                        |
| `build.${bundler}.${prefix}.entries.count`           | `[]`                                                                             | count        | Number of entries.                                     |
| `build.${bundler}.${prefix}.entries.modules.count`   | `[entryName:${name}]`                                                            | count        | Number of modules from an entry.                       |
| `build.${bundler}.${prefix}.entries.size`            | `[entryName:${name}]`                                                            | bytes        | Total size of an entry (and all its assets).           |
| `build.${bundler}.${prefix}.errors.count`            | `[]`                                                                             | count        | Number of errors generated by the build.               |
| `build.${bundler}.${prefix}.metrics.count`           | `[]`                                                                             | count        | Number of metrics sent to Datadog.                     |
| `build.${bundler}.${prefix}.modules.count`           | `[]`                                                                             | count        | Number of modules.                                     |
| `build.${bundler}.${prefix}.modules.dependencies`    | `[moduleName:${name}, moduleType:${type}, assetName:${name}, entryName:${name}]` | count        | Number of dependencies a module has.                   |
| `build.${bundler}.${prefix}.modules.dependents`      | `[moduleName:${name}, moduleType:${type}, assetName:${name}, entryName:${name}]` | count        | Number of dependents a module has.                     |
| `build.${bundler}.${prefix}.modules.size`            | `[moduleName:${name}, moduleType:${type}, assetName:${name}, entryName:${name}]` | bytes        | Size of a module.                                      |
| `build.${bundler}.${prefix}.plugins.meta.duration`   | `[pluginName:datadogwebpackplugin]`                                              | milliseconds | Duration of the process of the Webpack Datadog plugin. |
| `build.${bundler}.${prefix}.warnings.count`          | `[]`                                                                             | count        | Number of warnings generated by the build.             |

We also have some metrics that are only available to `esbuild` and `webpack` when the [`enableTracing`](#enableTracing) option is set to `true`:

| Metric                                               | Tags                                     | Type         | Description                         |
| :--------------------------------------------------- | :--------------------------------------- | :----------- | :---------------------------------- |
| `build.${bundler}.${prefix}.loaders.count`           | `[]`                                     | count        | Number of loaders.                  |
| `build.${bundler}.${prefix}.loaders.duration`        | `[loaderName:${name}]`                   | milliseconds | Runtime duration of a loader.       |
| `build.${bundler}.${prefix}.loaders.increment`       | `[loaderName:${name}]`                   | count        | Number of hit a loader had.         |
| `build.${bundler}.${prefix}.plugins.count`           | `[]`                                     | count        | Number of plugins.                  |
| `build.${bundler}.${prefix}.plugins.duration`        | `[pluginName:${name}]`                   | milliseconds | Total runtime duration of a plugin. |
| `build.${bundler}.${prefix}.plugins.hooks.duration`  | `[pluginName:${name}, hookName:${name}]` | milliseconds | Runtime duration of a hook.         |
| `build.${bundler}.${prefix}.plugins.hooks.increment` | `[pluginName:${name}, hookName:${name}]` | count        | Number of hit a hook had.           |
| `build.${bundler}.${prefix}.plugins.increment`       | `[pluginName:${name}]`                   | count        | Number of hit a plugin had.         |

## Dashboard

![](/packages/assets/src/datadog-dashboard.png)

> [!TIP]
> You can get this dashboard's configuration by running `yarn cli dashboard --prefix <your.prefix>` at the root of this repo.
