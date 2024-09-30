# Datadog Build Plugins <!-- #omit in toc -->

A set of plugins to interact with Datadog directly from your builds.

## ✨ Key takeaways ✨ <!-- #omit in toc -->

-   This is a bundler plugin for <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" /> Webpack, <img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> Vite, <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> ESBuild and <img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> Rollup.
-   Very easy to setup and disable on the fly.

> [!NOTE]
> If you want to upgrade from v1 to v2, please follow our [migration guide](./MIGRATIONS.md#v1-to-v2).

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Bundler Plugins](#bundler-plugins)
    -   [ESBuild](#-esbuild)
    -   [Rollup](#-rollup)
    -   [Vite](#-vite)
    -   [Webpack](#-webpack)
-   [Features](#features)
    -   [RUM](#rum----)
    -   [Telemetry](#telemetry----)
-   [Configuration](#configuration)
    -   [`auth.apiKey`](#authapikey)
    -   [`logLevel`](#loglevel)
    -   [`customPlugins`](#customplugins)
-   [Contributing](#contributing)
-   [License](#license)
<!-- #toc -->

## Bundler Plugins

<!-- #list-of-bundlers -->
### <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> ESBuild

`@datadog/esbuild-plugin`

#### Installation
-   Yarn

```bash
yarn add -D @datadog/esbuild-plugin
```

-   NPM

```bash
npm install --save-dev @datadog/esbuild-plugin
```


#### Usage
```js
const { datadogEsbuildPlugin } = require('@datadog/esbuild-plugin');

require('esbuild').build({
    plugins: [
        datadogEsbuildPlugin({
            // Configuration
        }),
    ],
});
```

> [!TIP]
> It is important to have the plugin in the first position in order to report every other plugins.


<kbd>[📝 More details ➡️](./packages/esbuild-plugin#readme)</kbd>

### <img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> Rollup

`@datadog/rollup-plugin`

#### Installation
-   Yarn

```bash
yarn add -D @datadog/rollup-plugin
```

-   NPM

```bash
npm install --save-dev @datadog/rollup-plugin
```


#### Usage
Inside your `rollup.config.js`.

```js
import { datadogRollupPlugin } from '@datadog/rollup-plugin';

export default {
    plugins: [
        datadogRollupPlugin({
            // Configuration
        }),
    ],
};
```

> [!TIP]
> It is important to have the plugin in the first position in order to report every other plugins.


<kbd>[📝 More details ➡️](./packages/rollup-plugin#readme)</kbd>

### <img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> Vite

`@datadog/vite-plugin`

#### Installation
-   Yarn

```bash
yarn add -D @datadog/vite-plugin
```

-   NPM

```bash
npm install --save-dev @datadog/vite-plugin
```


#### Usage
Inside your `vite.config.js`.

```js
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
        datadogVitePlugin({
            // Configuration
        }),
    ],
};
```

> [!TIP]
> It is important to have the plugin in the first position in order to report every other plugins.


<kbd>[📝 More details ➡️](./packages/vite-plugin#readme)</kbd>

### <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" /> Webpack

`@datadog/webpack-plugin`

#### Installation
-   Yarn

```bash
yarn add -D @datadog/webpack-plugin
```

-   NPM

```bash
npm install --save-dev @datadog/webpack-plugin
```


#### Usage
Inside your `webpack.config.js`.

```js
const { datadogWebpackPlugin } = require('@datadog/webpack-plugin');

module.exports = {
    plugins: [
        datadogWebpackPlugin({
            // Configuration
        }),
    ],
};
```

> [!TIP]
> It is important to have the plugin in the first position in order to report every other plugins.


<kbd>[📝 More details ➡️](./packages/webpack-plugin#readme)</kbd>
<!-- #list-of-bundlers -->

## Features

<!-- #list-of-packages -->
### RUM <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> <img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> <img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" />

> Interact with our Real User Monitoring product (RUM) in Datadog directly from your build system.

```typescript
datadogWebpackPlugin({
    rum?: {
        disabled?: boolean,
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

<kbd>[📝 Full documentation ➡️](./packages/plugins/rum#readme)</kbd>

### Telemetry <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> <img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> <img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" />

> Display and send telemetry data as metrics to Datadog.

```typescript
datadogWebpackPlugin({
    telemetry?: {
        disabled?: boolean,
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

<kbd>[📝 Full documentation ➡️](./packages/plugins/telemetry#readme)</kbd>
<!-- #list-of-packages -->

## Configuration

<!-- #full-configuration -->
```typescript
{
    auth?: {
        apiKey?: string;
    };
    customPlugins?: (options: Options, context: GlobalContext) => UnpluginPlugin[];
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none';
    rum?: {
        disabled?: boolean;
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
    telemetry?: {
        disabled?: boolean;
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
}
```
<!-- #full-configuration -->

### `auth.apiKey`

> default `null`

In order to interact with Datadog, you have to use [your own API Key](https://app.datadoghq.com/organization-settings/api-keys).

### `logLevel`

> default: `'warn'`

Which level of log do you want to show.

### `customPlugins`

> default: `[]`

This is a way for you to inject any [Unplugin Plugin](https://unplugin.unjs.io/guide/) you want.

It's particularly useful to use our global, shared context of the main plugin.

Or to prototype some new plugins in the same environment.

```typescript
{
    customPlugins: (options, context) => [{
        name: 'my-custom-plugin',
        buildStart() {
            console.log('Hello world');
        },
    }];
}
```

Your function will receive two arguments:

- `options`: The options you passed to the main plugin (including your custom plugins).
- `context`: The global context shared accross our plugin.

<!-- #global-context-type -->
```typescript
type GlobalContext = {
    // Mirror of the user's config.
    auth?: {
        apiKey?: string;
    };
    // More details on the currently running bundler.
    bundler: {
        name: string;
        fullName: string; // Including its variant.
        outDir: string; // Output directory
        // Added in `buildStart`.
        rawConfig?: any;
        variant: string; // Major version of the bundler (webpack 4, webpack 5)
    };
    // Added in `writeBundle`.
    build: {
        errors: string[];
        warnings: string[];
        // The list of entries used in the build.
        entries ? : {
            filepath: string;
            inputs: Input[],
            name: string;
            outputs: Output[]
            size: number;
            type: string,
        } [];
        // The list of inputs used in the build.
        inputs ? : {
            filepath: string;
            dependencies: Input[];
            dependents: Input[]
            name: string;
            size: number;
            type: string,
        } [];
        // The list of outputs generated by the build.
        outputs ? : {
            filepath: string;
            name: string;
            size: number;
            type: string,
            // Sourcemaps will use Outputs as their Inputs.
            inputs: (Input | Output)[]
        } [];
        start?: number;
        end?: number;
        duration?: number;
        writeDuration?: number;
    };
    cwd: string;
    // Added in `buildStart`.
    git?: {
        hash: string;
        remote: string;
        trackedFilesMatcher: [TrackedFilesMatcher](packages/core/src/plugins/git/trackedFilesMatcher.ts);
    };
    inject: (item: { type: 'file' | 'code'; value: string; fallback?: @self }) => void;
    start: number;
    version: string;
}
```

> [!NOTE]
> Some parts of the context are only available after certain hooks:
>   - `context.bundler.rawConfig` is added in the `buildStart` hook.
>   - `context.build.*` is populated in the `writeBundle` hook.
>   - `context.git.*` is populated in the `buildStart` hook.

<!-- #global-context-type -->

Your function will need to return an array of [Unplugin Plugins definitions](https://unplugin.unjs.io/guide/#supported-hooks).

## Contributing

Check out [CONTRIBUTING.md](CONTRIBUTING.md) for more information about how to work with the build-plugins ecosystem.

## License

[MIT](LICENSE)

<kbd>[Back to top :arrow_up:](#top)</kbd>
