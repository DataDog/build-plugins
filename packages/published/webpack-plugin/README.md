# Datadog Webpack Plugin

A Wepack plugin to interact with Datadog from your Webpack builds.

## Installation

-   Yarn

```bash
yarn add -D @datadog/webpack-plugin
```

-   npm

```bash
npm install --save-dev @datadog/webpack-plugin
```

## Usage

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

## Configuration

Check the main [README](/README.md#configuration) for the common configuration options.
