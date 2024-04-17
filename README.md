# Build plugin <!-- omit in toc -->

Track your build performances like never before.

![Yarn's build-plugin output](./packages/assets/build-plugin-output.png)

> [Yarn](https://github.com/yarnpkg/berry)'s build-plugin output.

---

## ✨ Key takeaways ✨ <!-- omit in toc -->

-   This is a bundler plugin (webpack and esbuild for now).
-   It monitors plugins, loaders, hooks, dependencies, modules, chunks, ...
-   It doesn't add runtime.
-   Very easy to setup and disable on the fly.
-   Totally extendable thanks to a hook architecture.

---

## Table of content <!-- omit in toc -->

<details>
<summary>Click to expand</summary>

-   [Installation](#installation)
-   [Usage](#usage)
    -   [Webpack](#webpack)
    -   [Esbuild](#esbuild)
-   [Configuration](#configuration)
    -   [`disabled`](#disabled)
    -   [`output`](#output)
    -   [`context`](#context)
-   [Integrations](#integrations)
    -   [`datadog`](#datadog)
-   [Contributing](#contributing)
    -   [Clone the repo](#clone-the-repo)
    -   [Install dependencies](#install-dependencies)
    -   [Tests](#tests)
    -   [Formatting, Linting and Compiling](#formatting-linting-and-compiling)
    -   [Open Source compliance](#open-source-compliance)
    -   [Documentation](#documentation)
    -   [Publishing](#publishing)
-   [License](#license)

</details>

## Installation

-   Yarn

```bash
yarn add @datadog/build-plugin
```

-   NPM

```bash
npm install --save @datadog/build-plugin
```

## Usage

### Webpack

Inside your `webpack.config.js`.

```js
const { BuildPlugin } = require('@datadog/build-plugin/dist/webpack');

module.exports = {
    plugins: [new BuildPlugin()],
};
```

**📝 Note: It is important to have the plugin in the first position in order to report every other plugins.**

### Esbuild

Add the plugin to your esbuild configuration.

```js
const esbuild = require('esbuild');
const { BuildPlugin } = require('@datadog/build-plugin/dist/esbuild');

esbuild.build({
  [...] // All your configuration needs
  plugins: [
    [...] // All your plugins
    BuildPlugin()
  ]
})
```

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
-   `bundler.json`: some 'stats' from your bundler.
-   `timings.json`: timing data for modules, loaders and plugins.

You can also pass an object of the form:

```javascript
{
    destination: 'path/to/destination',
    timings: true
}
```

To only output a specified file.

### `context`

> default: `webpack.config.context`

Used to have a more friendly name for modules. It will remove the `context` part of every module names.

## Integrations

### `datadog`

> default: `null`

An object used to automatically send your build data to Datadog.

![](./packages/assets/datadog-dashboard.png)

> You can get this dashboard's configuration by running `yarn cli dashboard --prefix <your.prefix>`.

The most basic configuration looks like this, consult
[the full integration documentation](./packages/core/hooks/datadog) for more details.

```javascript
new BuildPlugin({
    datadog: {
        apiKey: '<mydatadogkey>',
    },
});
```

---

## Contributing

### Clone the repo

```bash
git clone git@github.com:DataDog/build-plugin.git
```

### Install dependencies

This repository will need [Yarn](https://yarnpkg.com/).

```bash
brew install yarn
```

No worry about the version, it's embedded in the repo.

Then you can ensure dependencies are up to date in the repository.

```bash
cd build-plugin
yarn
```

### Tests

```bash
yarn test
```

⚠️ If you're modifying a behavior or adding a new feature,
update/add the required tests to your PR.

### Formatting, Linting and Compiling

We're using [eslint](https://eslint.org/) and [prettier](https://prettier.io/) to lint and format the code.

It's automatically done at save time when you're using [VSCode](https://code.visualstudio.com/) or you can run a command to do it manually:

```bash
yarn format
```

We're also using [TypeScript](https://www.typescriptlang.org/).

```bash
# Simply typecheck your code
yarn typecheck

# Build it
yarn build

# Watch changes
yarn watch
```

All of this will also be checked in the precommit hook.

### Open Source compliance

We follow a few rules, so we made a simple command to keep it compliant.

```bash
# Make the code compliant with our Open Source rules.
yarn oss
```

It will:

-   update headers of each files.
-   update `LICENSES-3rdparty.csv`, `LICENSE`, `NOTICE` and `README.md` with the correct license.

### Documentation

We try to keep the documentation as up to date as possible.

⚠️ If you're modifying a behavior or adding a new feature,
update/add the required documentation to your PR.

### Publishing

An automatic GitHub Action will take care of publishing new releases in the `latest` channel.

You can also publish a version in the `alpha` channel so you can easily test your changes:

1. First you need to bump the version in `package.json` with a marker for the channel, ex: `0.4.2-alpha` so we don't occupy a version of the `latest` channel.
1. Run these:

```bash
# First add your write token
yarn config set npmAuthToken $NPM_DD_WRITE_TOKEN

# Publish to the alpha channel
yarn npm publish --tag=alpha
```

---

## License

[MIT](LICENSE)
