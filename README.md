# Datadog Build Plugins <!-- #omit in toc -->

A set of bundler plugins for:
<!-- #list-of-bundlers -->
- [<img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> esbuild `@datadog/esbuild-plugin`](/packages/published/esbuild-plugin#readme)
- [<img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> Rollup `@datadog/rollup-plugin`](/packages/published/rollup-plugin#readme)
- [<img src="packages/assets/src/rspack.svg" alt="Rspack" width="17" /> Rspack `@datadog/rspack-plugin`](/packages/published/rspack-plugin#readme)
- [<img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> Vite `@datadog/vite-plugin`](/packages/published/vite-plugin#readme)
- [<img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" /> Webpack `@datadog/webpack-plugin`](/packages/published/webpack-plugin#readme)
<!-- #list-of-bundlers -->

To interact with Datadog directly from your builds.

> [!NOTE]
> If you want to upgrade from v1 to v2, please follow our [migration guide](/MIGRATIONS.md#v1-to-v2).

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Installation](#installation)
-   [Usage](#usage)
-   [Configuration](#configuration)
    -   [`auth.apiKey`](#authapikey)
    -   [`auth.appKey`](#authappkey)
    -   [`customPlugins`](#customplugins)
    -   [`enableGit`](#enablegit)
    -   [`logLevel`](#loglevel)
    -   [`metadata.name`](#metadataname)
-   [Features](#features)
    -   [Error Tracking](#error-tracking-----)
    -   [Metrics](#metrics-----)
-   [Contributing](#contributing)
-   [License](#license)
<!-- #toc -->

## Installation

-   Yarn

```bash
yarn add -D @datadog/{{bundler}}-plugin
```

-   npm

```bash
npm install --save-dev @datadog/{{bundler}}-plugin
```

## Usage

In your bundler's configuration file:

```js
const { datadog{{Bundler}}Plugin } = require('@datadog/{{bundler}}-plugin');

export const config = {
    plugins: [
        datadog{{Bundler}}Plugin({
            // Configuration
        }),
    ],
};
```

> [!TIP]
> It is best to have the plugin in the first position in order to report every other plugins.

Follow the specific documentation for each bundler:
<!-- #list-of-bundlers -->
- [<img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> esbuild `@datadog/esbuild-plugin`](/packages/published/esbuild-plugin#readme)
- [<img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> Rollup `@datadog/rollup-plugin`](/packages/published/rollup-plugin#readme)
- [<img src="packages/assets/src/rspack.svg" alt="Rspack" width="17" /> Rspack `@datadog/rspack-plugin`](/packages/published/rspack-plugin#readme)
- [<img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> Vite `@datadog/vite-plugin`](/packages/published/vite-plugin#readme)
- [<img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" /> Webpack `@datadog/webpack-plugin`](/packages/published/webpack-plugin#readme)
<!-- #list-of-bundlers -->

## Configuration

<details>

<summary>Full configuration object</summary>

<!-- #full-configuration -->
```typescript
{
    auth?: {
        apiKey?: string;
        appKey?: string;
    };
    customPlugins?: (arg: GetPluginsArg) => UnpluginPlugin[];
    enableGit?: boolean;
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none',
    metadata?: {
        name?: string;
    };;
    errorTracking?: {
        enable?: boolean;
        sourcemaps?: {
            bailOnError?: boolean;
            dryRun?: boolean;
            intakeUrl?: string;
            maxConcurrency?: number;
            minifiedPathPrefix: string;
            releaseVersion: string;
            service: string;
        };
    };
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
    };
}
```
<!-- #full-configuration -->

</details>

### `auth.apiKey`

> default `null`

In order to interact with Datadog, you have to use [your own API Key](https://app.datadoghq.com/organization-settings/api-keys).

### `auth.appKey`

> default `null`

In order to interact with Datadog, you have to use [your own Application Key](https://app.datadoghq.com/organization-settings/application-keys).

### `customPlugins`

> default: `[]`

This is a way for you to inject any [Unplugin Plugin](https://unplugin.unjs.io/guide/) you want.

It's particularly useful to use our [global, shared context](/packages/factory/README.md#global-context) of the main plugin.

And to prototype some new plugins in the same environment.

```typescript
{
    customPlugins: ({ options, context }) => {
        const name = 'my-custom-plugin';
        const log = context.getLogger(name);

        return [{
            name,
            buildStart() {
                log.info('Hello world');
            },
        }]
    };
}
```

Your function will receive three arguments:

- `options`: The options you passed to the main plugin (including your custom plugins).
- `context`: The global context shared accross our plugin.
- `bundler`: The currently running bundler's instance.

The `context` is a shared object that is mutated during the build process.

Your function has to return an array of [Unplugin Plugins definitions](https://unplugin.unjs.io/guide/#supported-hooks).<br/>
You can also use our own [custom hooks](/packages/plugins/custom-hooks#existing-hooks).

<details>

<summary>Full context object</summary>

<!-- #global-context-type -->
<pre>
type GlobalContext = {
    // Trigger an asynchronous <a href="/packages/plugins/custom-hooks#readme" title="CustomHooks">custom hook</a>.
    asyncHook: async (name: string, ...args: any[]) => Promise<void>;
    // Mirror of the user's config.
    auth?: {
        apiKey?: string;
        appKey?: string;
    };
    // Available in the `buildReport` hook.
    build: <a href="/packages/plugins/build-report#readme" title="BuildReport">BuildReport</a>;
    // Available in the `bundlerReport` hook.
    bundler: <a href="/packages/plugins/bundler-report#readme" title="BundlerReport">BundlerReport</a>;
    cwd: string;
    env: string;
    getLogger: (name: string) => <a href="#logger" title="Logger">Logger</a>;
    // Available in the `git` hook.
    git?: <a href="/packages/plugins/git#readme" title="Git">Git</a>;
    // Trigger a synchronous <a href="/packages/plugins/custom-hooks#readme" title="CustomHooks">custom hook</a>.
    hook: (name: string, ...args: any[]) => void;
    inject: <a href="/packages/plugins/injection#readme" title="Injection">Injection</a>;
    // The list of all the plugin names that are currently running in the ecosystem.
    pluginNames: string[];
    // The list of all the plugin instances that are currently running in the ecosystem.
    plugins: Plugin[];
    // Send a log to Datadog.
    sendLog: ({ message: string, context?: Record<string, string> }) => Promise<void>;
    // The start time of the build.
    start: number;
    // The version of the plugin.
    version: string;
}
</pre>
<!-- #global-context-type -->

</details>

#### [📝 Full documentation ➡️](/packages/factory#global-context)


### `enableGit`

> default: `true`

Enable the [Git plugin](/packages/plugins/git#readme) to use git information in your build.<br/>
Set to `false` if you don't want to use it, for instance if you see a `Error: No git remotes available` error.

### `logLevel`

> default: `'warn'`

Which level of log do you want to show.

### `metadata.name`
> default: `null`

The name of the build.<br/>
This is used to identify the build in logs, metrics and spans.

## Features

<!-- #list-of-packages -->
### Error Tracking <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> <img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> <img src="packages/assets/src/rspack.svg" alt="Rspack" width="17" /> <img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" />

> Interact with Error Tracking directly from your build system.

#### [📝 Full documentation ➡️](/packages/plugins/error-tracking#readme)

<details>

<summary>Configuration</summary>

```typescript
datadogWebpackPlugin({
    errorTracking?: {
        enable?: boolean,
        sourcemaps?: {
            bailOnError?: boolean,
            dryRun?: boolean,
            intakeUrl?: string,
            maxConcurrency?: number,
            minifiedPathPrefix: string,
            releaseVersion: string,
            service: string,
        },
    }
});
```

</details>

### Metrics <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> <img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> <img src="packages/assets/src/rspack.svg" alt="Rspack" width="17" /> <img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" />

> Display and send metrics to Datadog.

#### [📝 Full documentation ➡️](/packages/plugins/metrics#readme)

<details>

<summary>Configuration</summary>

```typescript
datadogWebpackPlugin({
    metrics?: {
        enable?: boolean,
        enableStaticPrefix?: boolean,
        enableTracing?: boolean,
        endPoint?: string,
        output?: boolean
            | string
            | {
                destination: string,
                timings?: boolean,
                metrics?: boolean,
            },
        prefix?: string,
        tags?: string[],
        timestamp?: number,
        filters?: ((metric: Metric) => Metric | null)[],
    }
});
```

</details>
<!-- #list-of-packages -->

## Contributing

Check out [CONTRIBUTING.md](/CONTRIBUTING.md) for more information about how to work with the build-plugins ecosystem.

## License

[MIT](/LICENSE)

### [Back to top :arrow_up:](#top) <!-- #omit in toc -->
