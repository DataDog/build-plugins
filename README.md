# Datadog Build Plugins <!-- #omit in toc -->

A set of plugins to interact with Datadog directly from your builds.

---

## ✨ Key takeaways ✨ <!-- #omit in toc -->

-   This is a cross bundler plugin (webpack and esbuild for now).
-   Very easy to setup and disable on the fly.

---

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli docs -->

<!-- #toc -->
<!-- #toc -->

## Packages

<!-- #list-of-packages -->
<!-- #list-of-packages -->

## Configuration

```javascript
{
    auth: {
        apiKey: '<mydatadogkey>',
    },
    [plugin-name]: {
        disabled: true,
        [...plugin-specific-configuration],
    }
}
```

### `auth.apiKey`

> required

In order to interact with Datadog, you have to use [your own API Key](https://app.datadoghq.com/account/settings#api).

Without a key, the plugin won't send anything to Datadog.

---

## Contributing

Check out the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

---

## License

[MIT](LICENSE)

---

<kbd>[Back to top :arrow_up:](#top)</kbd>
