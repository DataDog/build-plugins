# Datadog Build Plugins <!-- #omit in toc -->

A set of plugins to interact with Datadog directly from your builds.

> [!NOTE]
> If you want to upgrade from v1 to v2, please follow our [migration guide](./MIGRATIONS.md#v1-to-v2).

---

## ✨ Key takeaways ✨ <!-- #omit in toc -->

-   This is a cross bundler plugin (webpack and esbuild for now).
-   Very easy to setup and disable on the fly.

---

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Plugins](#plugins)
    -   [`rum` RUM Plugin](#rum-rum-plugin)
    -   [`telemetry` Telemetry Plugin](#telemetry-telemetry-plugin)
-   [Configuration](#configuration)
    -   [`auth.apiKey`](#authapikey)
    -   [`auth.endPoint`](#authendpoint)
    -   [`logLevel`](#loglevel)
-   [Contributing](#contributing)
-   [License](#license)
<!-- #toc -->

## Plugins

<!-- #list-of-packages -->
### `rum` RUM Plugin

> Interact with our Real User Monitoring product (RUM) in Datadog directly from your build system.

<kbd>[📝 Full documentation ➡️](./packages/plugins/rum#readme)</kbd>

### `telemetry` Telemetry Plugin

> Display and send telemetry data as metrics to Datadog.

<kbd>[📝 Full documentation ➡️](./packages/plugins/telemetry#readme)</kbd>
<!-- #list-of-packages -->

## Configuration

<details>
<summary>Full configuration</summary>

<!-- #full-configuration -->
```typescript
{
    auth?: {
        apiKey?: string;
        endPoint?: string;
    };
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none';
    rum?: {
        disabled?: boolean;
        sourcemaps?: {
            basePath: string;
            dryRun?: boolean;
            intakeUrl?: string;
            maxConcurrency?: number;
            minifiedPathPrefix?: string;
            releaseVersion: string;
            service: string;
        };
    };
    telemetry?: {
        disabled?: boolean;
        output?: boolean
            | string
            | {
                destination: string;
                timings?: boolean;
                dependencies?: boolean;
                bundler?: boolean;
                metrics?: boolean;
                logs?: boolean;
            };
        prefix?: string;
        tags?: string[];
        timestamp?: number;
        filters?: ((metric: Metric) => Metric | null)[];
    }
}
```
<!-- #full-configuration -->

</details>

### `auth.apiKey`

> default `null`

In order to interact with Datadog, you have to use [your own API Key](https://app.datadoghq.com/account/settings#api).

### `auth.endPoint`

> default: `"app.datadoghq.com"`

To which endpoint will the metrics be sent.

### `logLevel`

> default: `'warn'`

Which level of log do you want to show.

---

## Contributing

Check out the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

---

## License

[MIT](LICENSE)

---

<kbd>[Back to top :arrow_up:](#top)</kbd>
