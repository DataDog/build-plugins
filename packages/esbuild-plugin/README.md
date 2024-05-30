# Datadog ESBuild Plugin

A ESBuild plugin to interact with Datadog from your ESBuild builds.

## Installation

-   Yarn

```bash
yarn add -D @datadog/esbuild-plugin
```

-   NPM

```bash
npm install --save-dev @datadog/esbuild-plugin
```

## Usage

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

## Configuration

Check the main [README](../../README.md#configuration) for the common configuration options.
