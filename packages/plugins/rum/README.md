# Rum Plugin <!-- #omit in toc -->

Interact with Real User Monitoring (RUM) directly from your build system.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [React instrumentation](#react-instrumentation)
    -   [rum.react.router (alpha)](#rumreactrouter-alpha)
-   [Browser SDK Injection](#browser-sdk-injection)
    -   [rum.sdk.applicationId](#rumsdkapplicationid)
    -   [rum.sdk.clientToken](#rumsdkclienttoken)
    -   [rum.sdk.site](#rumsdksite)
    -   [rum.sdk.service](#rumsdkservice)
    -   [rum.sdk.env](#rumsdkenv)
    -   [rum.sdk.version](#rumsdkversion)
    -   [rum.sdk.trackingConsent](#rumsdktrackingconsent)
    -   [rum.sdk.trackViewsManually](#rumsdktrackviewsmanually)
    -   [rum.sdk.trackUserInteractions](#rumsdktrackuserinteractions)
    -   [rum.sdk.trackResources](#rumsdktrackresources)
    -   [rum.sdk.trackLongTasks](#rumsdktracklongtasks)
    -   [rum.sdk.defaultPrivacyLevel](#rumsdkdefaultprivacylevel)
    -   [rum.sdk.enablePrivacyForActionName](#rumsdkenableprivacyforactionname)
    -   [rum.sdk.actionNameAttribute](#rumsdkactionnameattribute)
    -   [rum.sdk.sessionSampleRate](#rumsdksessionsamplerate)
    -   [rum.sdk.sessionReplaySampleRate](#rumsdksessionreplaysamplerate)
    -   [rum.sdk.startSessionReplayRecordingManually](#rumsdkstartsessionreplayrecordingmanually)
    -   [rum.sdk.silentMultipleInit](#rumsdksilentmultipleinit)
    -   [rum.sdk.proxy](#rumsdkproxy)
    -   [rum.sdk.allowedTracingUrls](#rumsdkallowedtracingurls)
    -   [rum.sdk.traceSampleRate](#rumsdktracesamplerate)
    -   [rum.sdk.telemetrySampleRate](#rumsdktelemetrysamplerate)
    -   [rum.sdk.excludedActivityUrls](#rumsdkexcludedactivityurls)
    -   [rum.sdk.workerUrl](#rumsdkworkerurl)
    -   [rum.sdk.compressIntakeRequests](#rumsdkcompressintakerequests)
    -   [rum.sdk.storeContextsAcrossPages](#rumsdkstorecontextsacrosspages)
    -   [rum.sdk.allowUntrustedEvents](#rumsdkallowuntrustedevents)
<!-- #toc -->

## Configuration

<details>
<summary>Full configuration</summary>

```ts
rum?: {
    disabled?: boolean;
    react?: {
        router?: boolean;
    };
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

## React instrumentation

Automatically inject and instrument [RUM's React and React Router integrations](https://github.com/DataDog/browser-sdk/tree/main/packages/rum-react#react-router-integration).

### rum.react.router (alpha)

> default: false

It will:

1. inject `@datadog/browser-rum-react` into your bundle.
2. enable the plugin in the RUM SDK.
3. automatically instrument your React Router routes.
    a. For now, it only instruments `createBrowserRouter`.

> [!IMPORTANT]
> - You need to have `react` and`react-router-dom` into your dependencies.
> - This feature is in alpha and may not work as expected in all cases.

## Browser SDK Injection

Automatically inject the RUM SDK into your application.

### rum.sdk.applicationId

> required

The RUM application ID. [Create a new application if necessary](https://app.datadoghq.com/rum/list/create).

### rum.sdk.clientToken

> optional, will be fetched if missing

A [Datadog client token](https://docs.datadoghq.com/account_management/api-app-keys/#client-tokens).

> [!NOTE]
> If not provided, the plugin will attempt to fetch the client token using the API.
> You need to provide both `auth.apiKey` and `auth.appKey` with the `rum_apps_read` permission.

### rum.sdk.site

> default: `"datadoghq.com"`

[The Datadog site parameter of your organization](https://docs.datadoghq.com/getting_started/site/).

### rum.sdk.service

> optional

The service name for your application. Follows the [tag syntax requirements](https://docs.datadoghq.com/getting_started/tagging/#define-tags).

### rum.sdk.env

> optional

The application’s environment, for example: `prod`, `pre-prod`, and `staging`. Follows the [tag syntax requirements](https://docs.datadoghq.com/getting_started/tagging/#define-tags).

### rum.sdk.version

> optional

The application’s version, for example: `1.2.3`, `6c44da20`, and `2020.02.13`. Follows the [tag syntax requirements](https://docs.datadoghq.com/getting_started/tagging/#define-tags).

### rum.sdk.trackingConsent

> default: `"granted"`

Set the initial user tracking consent state. See [User Tracking Consent](https://docs.datadoghq.com/real_user_monitoring/browser/advanced_configuration/#user-tracking-consent).

### rum.sdk.trackViewsManually

> default: `false`

Allows you to control RUM views creation. See [override default RUM view names](https://docs.datadoghq.com/real_user_monitoring/browser/advanced_configuration/#override-default-rum-view-names).

### rum.sdk.trackUserInteractions

> default: `false`

Enables [automatic collection of users actions](https://docs.datadoghq.com/real_user_monitoring/browser/tracking_user_actions/).

### rum.sdk.trackResources

> default: `false`

Enables collection of resource events.

### rum.sdk.trackLongTasks

> default: `false`

Enables collection of long task events.

### rum.sdk.defaultPrivacyLevel

> default: `"mask"`

See [Session Replay Privacy Options](https://docs.datadoghq.com/real_user_monitoring/session_replay/browser/privacy_options/).

### rum.sdk.enablePrivacyForActionName

> default: `false`

See [Mask Action Names](https://docs.datadoghq.com/data_security/real_user_monitoring/#mask-action-names).

### rum.sdk.actionNameAttribute

> optional

Specify your own attribute to be used to [name actions](https://docs.datadoghq.com/real_user_monitoring/browser/tracking_user_actions/#declare-a-name-for-click-actions).

### rum.sdk.sessionSampleRate

> default: `100`

The percentage of sessions to track: `100` for all, `0` for none. Only tracked sessions send RUM events. For more details about `sessionSampleRate`, see the [sampling configuration](https://docs.datadoghq.com/real_user_monitoring/guide/sampling-browser-plans/).

### rum.sdk.sessionReplaySampleRate

> default: `0`

The percentage of tracked sessions with [Browser RUM & Session Replay pricing](https://www.datadoghq.com/pricing/?product=real-user-monitoring--session-replay#products) features: `100` for all, `0` for none. For more details about `sessionReplaySampleRate`, see the [sampling configuration](https://docs.datadoghq.com/real_user_monitoring/guide/sampling-browser-plans/).

### rum.sdk.startSessionReplayRecordingManually

> default: `false`

If the session is sampled for Session Replay, only start the recording when `startSessionReplayRecording()` is called, instead of at the beginning of the session. See [Session Replay Usage](https://docs.datadoghq.com/real_user_monitoring/session_replay/browser/#usage) for details.

### rum.sdk.silentMultipleInit

> default: `false`

Initialization fails silently if the RUM Browser SDK is already initialized on the page.

### rum.sdk.proxy

> optional

Proxy URL, for example: `https://www.proxy.com/path`. For more information, see the full [proxy setup guide](https://docs.datadoghq.com/real_user_monitoring/guide/proxy-rum-data/).

### rum.sdk.allowedTracingUrls

> optional

A list of request URLs used to inject tracing headers. For more information, see [Connect RUM and Traces](https://docs.datadoghq.com/real_user_monitoring/platform/connect_rum_and_traces/).

### rum.sdk.traceSampleRate

> default: `100`

The percentage of requests to trace: `100` for all, `0` for none. For more information, see [Connect RUM and Traces](https://docs.datadoghq.com/real_user_monitoring/platform/connect_rum_and_traces/).

### rum.sdk.telemetrySampleRate

> default: `20`

Telemetry data (such as errors and debug logs) about SDK execution is sent to Datadog to detect and solve potential issues. Set this option to `0` to opt out from telemetry collection.

### rum.sdk.excludedActivityUrls

> optional

A list of request origins ignored when computing the page activity. See [How page activity is calculated](https://docs.datadoghq.com/real_user_monitoring/browser/monitoring_page_performance/#how-page-activity-is-calculated).

### rum.sdk.workerUrl

> optional

URL pointing to the Datadog Browser SDK Worker JavaScript file. The URL can be relative or absolute, but is required to have the same origin as the web application. See [Content Security Policy guidelines](https://docs.datadoghq.com/integrations/content_security_policy_logs/?tab=firefox#use-csp-with-real-user-monitoring-and-session-replay) for more information.

### rum.sdk.compressIntakeRequests

> default: `false`

Compress requests sent to the Datadog intake to reduce bandwidth usage when sending large amounts of data. The compression is done in a Worker thread. See [Content Security Policy guidelines](https://docs.datadoghq.com/integrations/content_security_policy_logs/?tab=firefox#use-csp-with-real-user-monitoring-and-session-replay) for more information.

### rum.sdk.storeContextsAcrossPages

> default: `false`

Store global context and user context in `localStorage` to preserve them along the user navigation. See [Contexts life cycle](https://docs.datadoghq.com/real_user_monitoring/browser/advanced_configuration/#contexts-life-cycle) for more details and specific limitations.

### rum.sdk.allowUntrustedEvents

> default: `false`

Allow capture of [untrusted events](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted), for example in automated UI tests.
