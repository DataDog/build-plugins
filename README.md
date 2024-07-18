# Datadog Build Plugins <!-- #omit in toc -->

A set of plugins to interact with Datadog directly from your builds.

> [!NOTE]
> If you want to upgrade from v1 to v2, please follow our [migration guide](./MIGRATIONS.md#v1-to-v2).

---

## ✨ Key takeaways ✨ <!-- #omit in toc -->

-   This is a cross bundler plugin (webpack, esbuild, vite and rollup for now).
-   Very easy to setup and disable on the fly.

---

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Bundler Plugins](#bundler-plugins)
    -   [<img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> ESBuild](#img-srcpackagesassetssrcesbuildsvg-altesbuild-width17-esbuild)
    -   [<img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" /> Rollup](#img-srcpackagesassetssrcrollupsvg-altrollup-width17-rollup)
    -   [<img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> Vite](#img-srcpackagesassetssrcvitesvg-altvite-width17-vite)
    -   [<img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" /> Webpack](#img-srcpackagesassetssrcwebpacksvg-altwebpack-width17-webpack)
-   [Features](#features)
    -   [RUM <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" /> <img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> <img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" />](#rum-img-srcpackagesassetssrcwebpacksvg-altwebpack-width17-img-srcpackagesassetssrcvitesvg-altvite-width17-img-srcpackagesassetssrcesbuildsvg-altesbuild-width17-img-srcpackagesassetssrcrollupsvg-altrollup-width17-)
    -   [Telemetry <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" />](#telemetry-img-srcpackagesassetssrcesbuildsvg-altesbuild-width17-img-srcpackagesassetssrcwebpacksvg-altwebpack-width17-)
-   [Configuration](#configuration)
    -   [`auth.apiKey`](#authapikey)
    -   [`auth.endPoint`](#authendpoint)
    -   [`logLevel`](#loglevel)
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
### RUM <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" /> <img src="packages/assets/src/vite.svg" alt="Vite" width="17" /> <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> <img src="packages/assets/src/rollup.svg" alt="Rollup" width="17" />

> Interact with our Real User Monitoring product (RUM) in Datadog directly from your build system.

```typescript
datadogWebpackPlugin({
    rum?: {
        disabled?: boolean,
        sourcemaps?: {
            dryRun?: boolean,
            intakeUrl?: string,
            maxConcurrency?: number,
            minifiedPathPrefix?: string,
            releaseVersion: string,
            service: string,
        },
    }
});
```

<kbd>[📝 Full documentation ➡️](./packages/plugins/rum#readme)</kbd>

### Telemetry <img src="packages/assets/src/esbuild.svg" alt="ESBuild" width="17" /> <img src="packages/assets/src/webpack.svg" alt="Webpack" width="17" />

> Display and send telemetry data as metrics to Datadog.

```typescript
datadogWebpackPlugin({
    telemetry?: {
        disabled?: boolean,
        output?: boolean
            | string
            | {
                destination: string,
                timings?: boolean,
                dependencies?: boolean,
                bundler?: boolean,
                metrics?: boolean,
                logs?: boolean,
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
        endPoint?: string;
    };
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none';
    rum?: {
        disabled?: boolean;
        sourcemaps?: {
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
