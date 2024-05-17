# Datadog Build Plugins Core

A set of core helpers to use with the Datadog Build Plugins.

## Installation

-   Yarn

```bash
yarn add -D @datadog/build-plugins-core
```

-   NPM

```bash
npm install --save-dev @datadog/build-plugins-core
```

## Usage

### `defaultTelemetryFilters`

This is the list of the default filters used by the [telemetry plugin](../telemetry/README.md),
if you want to extend the list, you can re-use them.

```js
const { defaultTelemetryFilters } = require('@datadog/build-plugins-core');

module.exports = {
    plugins: [
        datadogWebpackPlugin({
            // Configuration
            telemetry: {
                filters: [
                    ...defaultTelemetryFilters,
                    // Your custom filters
                ],
            },
        }),
    ],
};
```
