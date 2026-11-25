# RUM Plugin <!-- #omit in toc -->

> [!NOTE]
> This feature is in **beta** and may misbehave in edgiest cases.

Interact with Real User Monitoring (RUM) directly from your build system.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Browser SDK Injection](#browser-sdk-injection)
    -   [Using global `DD_RUM`](#using-global-ddrum)
    -   [rum.sdk.applicationId](#rumsdkapplicationid)
    -   [rum.sdk.clientToken](#rumsdkclienttoken)
-   [Early Collection](#early-collection)
    -   [rum.earlyCollection](#rumearlycollection)
-   [Source Code Context](#source-code-context)
    -   [rum.sourceCodeContext.debugId](#rumsourcecodecontextdebugid)
<!-- #toc -->

## Configuration

<details>
<summary>Full configuration</summary>

```ts
rum?: {
    enable?: boolean;
    sdk?: {
        applicationId: string;
        clientToken?: string;
        // [...] See https://docs.datadoghq.com/real_user_monitoring/browser/setup/client?tab=rum#configuration for all options.
    };
    earlyCollection?: boolean;
    sourceCodeContext?:
        | {
              debugId: true;
              service?: string;
              version?: string;
          }
        | {
              debugId?: false;
              service?: string;
              version?: string;
          };
}
```

</details>

**Minimal configuration**:

```ts
rum: {
    sdk: {
        applicationId: 'your_application_id',
    }
}
```

## Browser SDK Injection

Automatically inject the RUM SDK v6 into your application and initialize it.

Full documentation can be found in the [Datadog documentation](https://docs.datadoghq.com/real_user_monitoring/browser/setup/client?tab=rum#configuration).

### Using global `DD_RUM`

You can use [the global `DD_RUM` object](https://docs.datadoghq.com/real_user_monitoring/browser/advanced_configuration/?tab=cdnasync) to interact with the RUM SDK.

> [!NOTE]
> You don't need to use `DD_RUM.onReady()` to wrap your code,
> the plugin makes sure the SDK is loaded before executing your code.

For TypeScript projects, you can declare the global type using the types bundled with the plugin:

```ts
import type { RumTypes } from '@datadog/webpack-plugin'; // or rollup-plugin, vite-plugin, etc.

declare global {
    interface Window {
        DD_RUM?: RumTypes['RumPublicApi'];
    }
}
```

You can also configure `eslint` to recognize the global `DD_RUM` object:

```json
{
    "globals": {
        "DD_RUM": "readonly"
    }
}
```

### rum.sdk.applicationId

> required

The RUM application ID. [Create a new application if necessary](https://app.datadoghq.com/rum/list/create).

### rum.sdk.clientToken

> optional, will be fetched if missing

A [Datadog client token](https://docs.datadoghq.com/account_management/api-app-keys/#client-tokens).

> [!NOTE]
> If not provided, the plugin will attempt to fetch the client token using the API.
> You need to provide both `auth.apiKey` and `auth.appKey` with the `rum_apps_read` permission.

## Early Collection

### rum.earlyCollection

> optional, defaults to `false`

Start the [JS Self-Profiling](https://wicg.github.io/js-self-profiling/) session before the application and the RUM SDK are loaded, so profiles cover the page load (HTML parsing, application boot, the SDK download itself) instead of starting when the SDK is evaluated.

When enabled, the plugin adds this tag as the **first child of the `<head>`** of every HTML page of the build:

```html
<script src="https://www.datadoghq-browser-agent.com/datadog-early-collection.js"></script>
```

The script (about 300 bytes) starts a `Profiler` and publishes it on `window._DD_EARLY_COLLECTION`. The RUM Browser SDK adopts it when it is evaluated. The script is idempotent and fails silently when profiling is unavailable.

The plugin does not generate HTML; it rewrites the HTML produced by your build:

| Bundler          | How                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Vite             | `transformIndexHtml` (build and dev server).                                                                                    |
| webpack / Rspack | Every `.html` asset, after `html-webpack-plugin` / `HtmlRspackPlugin` emitted it (build and dev server).                        |
| Rollup           | Every `.html` asset emitted by other plugins.                                                                                   |
| esbuild          | Every `.html` file of the output directory once the build ends. **List the Datadog plugin after the plugin writing your HTML.** |

If no HTML file is found (server-side rendered pages, libraries, ...), the plugin logs a warning and nothing is injected: add the tag above to your page template yourself.

With esbuild, the plugin only rewrites the HTML files found in the output directory (`outdir`, or the directory of `outfile`). It never touches the files when that directory is your project root or one of its parents, and it skips hidden directories, `node_modules` and symlinks. In watch mode, a plugin that rewrites your HTML on every rebuild can overwrite the injected tag.

> [!IMPORTANT]
> Requirements for it to have any effect:
>
> -   The page must be served with the response header `Document-Policy: js-profiling`, as for regular RUM profiling. Without it, or in a browser without the JS Self-Profiling API (only Chrome and Edge), the script does nothing.
> -   Profiling must be enabled on your RUM application (profiling sample rate above 0).
> -   Your RUM Browser SDK must be **v7.20.0 or later**. The script is served from the CDN as of the Browser SDK v7.20.0 release; before that the URL returns a 404 and the page is unaffected.
> -   The SDK injected by [`rum.sdk`](#browser-sdk-injection) is **not** v7.20.0+ yet, so it does not adopt the early session (the plugin logs a warning). Load a compatible SDK yourself to benefit from this option.
> -   If you use a Content Security Policy, allow `https://www.datadoghq-browser-agent.com` in `script-src`. The plugin does not add a `nonce`, so a policy that requires nonces (or `strict-dynamic`) blocks the tag: add it to your template yourself.
>
> Good to know:
>
> -   The tag is a blocking request to the CDN, on purpose, so that the profiler starts before anything else. The URL is not versioned, so Subresource Integrity cannot be used.
> -   The tag is placed first in `<head>`, before any `<meta charset>` or `<meta http-equiv="Content-Security-Policy">`. Make sure your charset declaration is within the first 1024 bytes of the document, and prefer the `Content-Security-Policy` header over the meta tag.

## Source Code Context

Inject metadata that lets Datadog associate runtime stack frames with uploaded source maps.

To inject debug IDs:

```ts
datadogWebpackPlugin({
    sourcemaps: {
        debugId: true,
    },
});
```

To upload the corresponding source maps directly during the build, also set `sourcemaps.upload: true` and configure `auth.apiKey`. See the [Error Tracking plugin documentation](/packages/plugins/error-tracking#sourcemaps-upload) for upload configuration and options.

The existing `rum.sourceCodeContext.debugId` configuration remains supported. Service and version can be provided alongside `debugId`; they identify and filter the application or micro-frontend, while the debug ID independently associates stack frames with source maps.

When `rum.sourceCodeContext.service` isn't set, the plugin falls back to the shared top-level [`metadata.service`](/README.md#metadataservice). Without `debugId`, a service is required in one of the two places.

When `rum.sourceCodeContext.version` isn't set, the plugin falls back to the shared top-level [`metadata.version`](/README.md#metadataversion). With `debugId`, it only does so when `rum.sourceCodeContext.service` is set, so that setting `metadata.service` for another plugin doesn't add the version to every chunk.

### rum.sourceCodeContext.debugId

> default: `false`

Inject a deterministic debug ID into each JavaScript bundle. The RUM SDK uses it to associate stack frames with source maps.
