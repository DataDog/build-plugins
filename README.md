# Build plugin

Track your build data.

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

### disabled

> default: `false`

Plugin will be disabled and won't track anything.

### output

> default: `true`

If `true`, you'll see a top 5 of all metrics tracked by the plugin.
If a path, you'll also save json files at this location:

-   `dependencies.json`: track all dependencies and dependents of your modules.
-   `metrics.json`: an array of all the metrics that would be sent to Datadog.
-   `stats.json`: the `stats` object of webpack.
-   `timings.json`: timing data for modules, loaders and plugins.

### datadog

> default: `null`

You can setup your Datadog link in here.

Follow instruction in [the hook's README](./hooks/datadog).

---

## Contributing

---

## License

[MIT](LICENSE)
