# Datadog Rollup Plugin

A Rollup plugin to interact with Datadog from your builds.

## Installation

-   Yarn

```bash
yarn add -D @datadog/rollup-plugin
```

-   npm

```bash
npm install --save-dev @datadog/rollup-plugin
```

## Usage

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

## Configuration

Check the main [README](/README.md#configuration) for the common configuration options.
