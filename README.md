# Datadog Build Plugins <!-- omit in toc -->

A set of plugins to interact with Datadog directly from your builds.

---

## ✨ Key takeaways ✨ <!-- omit in toc -->

-   This is a cross bundler plugin (webpack and esbuild for now).
-   Very easy to setup and disable on the fly.

---

## Table of content <!-- omit in toc -->

<details>
<summary>Click to expand</summary>

- [Packages](#packages)
- [Configuration](#configuration)
  - [`auth.apiKey`](#authapikey)
  - [`auth.endPoint`](#authendpoint)
  - [`logLevel`](#loglevel)
- [Contributing](#contributing)
- [License](#license)

</details>

## Packages

<!-- #list-of-packages -->

## Configuration

```javascript
{
    auth: {
        apiKey: '<mydatadogkey>',
        endPoint: 'app.datadoghq.com',
    },
    logLevel: 'debug',
    [plugin-name]: {
        disabled: true,
        [...plugin-specific-configuration],
    }
}
```

### `auth.apiKey`

> default null

In order to interact with Datadog, you have to use [your own API Key](https://app.datadoghq.com/account/settings#api).

### `auth.endPoint`

> default: `"app.datadoghq.com"`

To which endpoint will the metrics be sent.

### `logLevel`

> default: 'warn'

Which level of log do you want to show.

---

## Contributing

Check out the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

---

## License

[MIT](LICENSE)

---

<kbd>[Back to top :arrow_up:](#top)</kbd>
