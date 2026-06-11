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

Automatically inject the RUM Browser SDK into your application and initialize it.

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
