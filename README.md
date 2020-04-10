# Build plugin

Track your build data.

![](./assets/build-plugin-output.png)

---

## ✨ Key takeaways ✨

-   This is a bundler plugin (webpack for now, others to come...).
-   It monitors plugins, loaders, hooks, dependencies, modules, chunks, ...
-   It doesn't add runtime.
-   Very easy to setup and disable on the fly.
-   Totally extendable thanks to a hook architecture.

---

## Installation

-   Yarn

```bash
yarn add build-plugin
```

-   NPM

```bash
npm install --save build-plugin
```

## Usage

Inside your `webpack.config.js`.

```js
const BuildPlugin = require('build-plugin/webpack');

module.exports = {
    plugins: [new BuildPlugin()]
};
```

**📝 Note: It is important to have the plugin in the first position in order to report every other plugins.**

## Configuration

The Build plugin accepts many options:

### `disabled`

> default: `false`

Plugin will be disabled and won't track anything.

### `output`

> default: `true`

If `true`, you'll see a top 5 of all metrics tracked by the plugin.
If a path, you'll also save json files at this location:

-   `dependencies.json`: track all dependencies and dependents of your modules.
-   `metrics.json`: an array of all the metrics that would be sent to Datadog.
-   `stats.json`: the `stats` object of webpack.
-   `timings.json`: timing data for modules, loaders and plugins.

## Integrations

### `datadog`

> default: `null`

An object used to automatically send your build data to Datadog.

![](./assets/datadog-dashboard.png)

The most basic configuration looks like this, consult
[the full integration documentation](./hooks/datadog) for more details.

```javascript
new BuildPlugin({
    datadog: {
        apiKey: '<mydatadogkey>'
    }
});
```

---

## Contributing

---

## License

[MIT](LICENSE)
