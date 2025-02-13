# RUM Plugin <!-- #omit in toc -->

Interact with Real User Monitoring (RUM) directly from your build system.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Browser SDK Injection](#browser-sdk-injection)
    -   [rum.sdk.applicationId](#rumsdkapplicationid)
    -   [rum.sdk.clientToken](#rumsdkclienttoken)
<!-- #toc -->

## Configuration

<details>
<summary>Full configuration</summary>

```ts
rum?: {
    disabled?: boolean;
    sdk?: {
        actionNameAttribute?: string;
        allowedTracingUrls?: string[];
        allowUntrustedEvents?: boolean;
        applicationId: string;
        clientToken?: string;
        compressIntakeRequests?: boolean;
        defaultPrivacyLevel?: 'mask' | 'mask-user-input' | 'allow';
        enablePrivacyForActionName?: boolean;
        env?: string;
        excludedActivityUrls?: string[];
        proxy?: string;
        service?: string;
        sessionReplaySampleRate?: number;
        sessionSampleRate?: number;
        silentMultipleInit?: boolean;
        site?: string;
        startSessionReplayRecordingManually?: boolean;
        storeContextsAcrossPages?: boolean;
        telemetrySampleRate?: number;
        traceSampleRate?: number;
        trackingConsent?: 'granted' | 'not_granted';
        trackLongTasks?: boolean;
        trackResources?: boolean;
        trackUserInteractions?: boolean;
        trackViewsManually?: boolean;
        version?: string;
        workerUrl?: string;
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

Automatically inject the RUM SDK into your application.

Full documentation can be found in the [Datadog documentation](https://docs.datadoghq.com/real_user_monitoring/browser/setup/client?tab=rum#configuration).

### rum.sdk.applicationId

> required

The RUM application ID. [Create a new application if necessary](https://app.datadoghq.com/rum/list/create).

### rum.sdk.clientToken

> optional, will be fetched if missing

A [Datadog client token](https://docs.datadoghq.com/account_management/api-app-keys/#client-tokens).

> [!NOTE]
> If not provided, the plugin will attempt to fetch the client token using the API.
> You need to provide both `auth.apiKey` and `auth.appKey` with the `rum_apps_read` permission.
