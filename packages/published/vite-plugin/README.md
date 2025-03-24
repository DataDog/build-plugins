# Datadog Vite Plugin

A Vite plugin to interact with Datadog from your builds.

## Installation

-   Yarn

```bash
yarn add -D @datadog/vite-plugin
```

-   npm

```bash
npm install --save-dev @datadog/vite-plugin
```

## Usage

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

## Configuration

Check the main [README](/README.md#configuration) for the common configuration options.
