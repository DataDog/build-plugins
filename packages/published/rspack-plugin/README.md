# Datadog Rspack Plugin

A Rspack plugin to interact with Datadog from your builds.

## Installation

-   Yarn

```bash
yarn add -D @datadog/rspack-plugin
```

-   npm

```bash
npm install --save-dev @datadog/rspack-plugin
```

## Usage

Inside your `rspack.config.js`.

```js
const { datadogRspackPlugin } = require('@datadog/rspack-plugin');

module.exports = {
    plugins: [
        datadogRspackPlugin({
            // Configuration
        }),
    ],
};
```

> [!TIP]
> It is important to have the plugin in the first position in order to report every other plugins.

## Configuration

Check the main [README](/README.md#configuration) for the common configuration options.
