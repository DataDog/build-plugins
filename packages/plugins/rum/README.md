# Rum Plugin <!-- #omit in toc -->

Interact with Real User Monitoring (RUM) directly from your build system.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
    -   [rum.enable](#rumenable)
-   [RUM SDK Injection](#rum-sdk-injection)
    -   [rum.sdk.applicationId](#rumsdkapplicationid)
    -   [rum.sdk.clientToken](#rumsdkclienttoken)
    -   [rum.sdk.site](#rumsdksite)
    -   [rum.sdk.sessionSampleRate](#rumsdksessionsamplerate)
    -   [rum.sdk.sessionReplaySampleRate](#rumsdksessionreplaysamplerate)
    -   [rum.sdk.defaultPrivacyLevel](#rumsdkdefaultprivacylevel)
    -   [rum.sdk.trackUserInteractions](#rumsdktrackuserinteractions)
    -   [rum.sdk.trackResources](#rumsdktrackresources)
    -   [rum.sdk.trackLongTasks](#rumsdktracklongtasks)
    -   [rum.sdk.trackViewsManually](#rumsdktrackviewsmanually)
    -   [rum.sdk.trackingConsent](#rumsdktrackingconsent)
    -   [rum.sdk.traceSampleRate](#rumsdktracesamplerate)
    -   [rum.sdk.telemetrySampleRate](#rumsdktelemetrysamplerate)
    -   [rum.sdk.allowUntrustedEvents](#rumsdkallowuntrustedevents)
    -   [rum.sdk.compressIntakeRequests](#rumsdkcompressintakerequests)
    -   [rum.sdk.enablePrivacyForActionName](#rumsdkenableprivacyforactionname)
    -   [rum.sdk.silentMultipleInit](#rumsdksilentmultipleinit)
    -   [rum.sdk.startSessionReplayRecordingManually](#rumsdkstartsessionreplayrecordingmanually)
    -   [rum.sdk.storeContextsAcrossPages](#rumsdkstorecontextsacrosspages)
-   [Privacy Transforms](#privacy-transforms)
    -   [rum.privacy.include](#rumprivacyinclude)
    -   [rum.privacy.exclude](#rumprivacyexclude)
    -   [rum.privacy.addToDictionaryFunctionName](#rumprivacyaddtodictionaryfunctionname)
    -   [rum.privacy.helperCodeExpression](#rumprivacyhelpercodeexpression)
-   [Source Code Context](#source-code-context)
    -   [rum.sourceCodeContext.service](#rumsourcecodecontextservice)
    -   [rum.sourceCodeContext.version](#rumsourcecodecontextversion)
<!-- #toc -->

## Configuration

```ts
rum?: {
    enable?: boolean;
    sdk?: {
        applicationId: string;
        clientToken?: string;
        site?: string;
        sessionSampleRate?: number;
        sessionReplaySampleRate?: number;
        defaultPrivacyLevel?: string;
        trackUserInteractions?: boolean;
        trackResources?: boolean;
        trackLongTasks?: boolean;
        trackViewsManually?: boolean;
        trackingConsent?: string;
        traceSampleRate?: number;
        telemetrySampleRate?: number;
        allowUntrustedEvents?: boolean;
        compressIntakeRequests?: boolean;
        enablePrivacyForActionName?: boolean;
        silentMultipleInit?: boolean;
        startSessionReplayRecordingManually?: boolean;
        storeContextsAcrossPages?: boolean;
    };
    privacy?: {
        include?: (string | RegExp)[];
        exclude?: (string | RegExp)[];
        addToDictionaryFunctionName?: string;
        helperCodeExpression?: string;
    };
    sourceCodeContext?: {
        service: string;
        version?: string;
    };
}
```

### rum.enable

> default: `true` when a `rum` config block is present, `false` otherwise.

Enable or disable the plugin without removing its configuration.

Must be a boolean. Non-boolean values are coerced today but will be rejected in a future major release.

## RUM SDK Injection

Automatically inject the Datadog RUM Browser SDK into your application at build time. When the `rum.sdk` block is provided, the plugin injects initialization code so you don't need to add the SDK script tag or call `datadogRum.init()` manually.

> [!NOTE]
> If `clientToken` is not provided, the plugin will attempt to fetch it automatically using `auth.apiKey` and `auth.appKey`.

### rum.sdk.applicationId

> required

The RUM application ID from Datadog.

### rum.sdk.clientToken

> optional — fetched automatically when `auth.apiKey` and `auth.appKey` are set.

The client token used by the RUM SDK to send data to Datadog.

### rum.sdk.site

> default: value of `auth.site` or `'datadoghq.com'`

The Datadog site to send RUM data to.

### rum.sdk.sessionSampleRate

> default: `100`

Percentage of sessions to track (0–100).

### rum.sdk.sessionReplaySampleRate

> default: `0`

Percentage of tracked sessions that include Session Replay recordings (0–100).

### rum.sdk.defaultPrivacyLevel

> default: `'mask'`

Default privacy level for Session Replay. Controls how content is masked in recordings.

### rum.sdk.trackUserInteractions

> default: `false`

Automatically collect user actions (clicks).

### rum.sdk.trackResources

> default: `false`

Automatically collect resource events.

### rum.sdk.trackLongTasks

> default: `false`

Automatically collect long task events.

### rum.sdk.trackViewsManually

> default: `false`

When `true`, RUM views must be started manually via the SDK API.

### rum.sdk.trackingConsent

> default: `'granted'`

Initial tracking consent. Use `'not-granted'` to defer collection until consent is given.

### rum.sdk.traceSampleRate

> default: `100`

Percentage of requests to trace (0–100). Controls APM trace correlation.

### rum.sdk.telemetrySampleRate

> default: `20`

Percentage of telemetry events sent to Datadog for SDK health monitoring.

### rum.sdk.allowUntrustedEvents

> default: `false`

Allow the SDK to capture programmatically dispatched (non-user) events.

### rum.sdk.compressIntakeRequests

> default: `false`

Compress data sent to the Datadog intake to reduce network bandwidth.

### rum.sdk.enablePrivacyForActionName

> default: `false`

When `true`, action names in Session Replay are masked for privacy.

### rum.sdk.silentMultipleInit

> default: `false`

Suppress console warnings when `datadogRum.init()` is called more than once.

### rum.sdk.startSessionReplayRecordingManually

> default: `false`

When `true`, Session Replay recording must be started manually via the SDK API.

### rum.sdk.storeContextsAcrossPages

> default: `false`

Persist global and user contexts across page navigations using `localStorage`.

## Privacy Transforms

Build-time code transforms that prepare your application for Session Replay privacy controls. When the `rum.privacy` block is provided, the plugin transforms source files to support action name masking and other privacy features.

### rum.privacy.include

> default: `[/\.(?:c|m)?(?:j|t)sx?$/]`

Array of file patterns (strings or RegExp) to include for privacy transforms. By default, all JavaScript and TypeScript files are included.

### rum.privacy.exclude

> default: `[/\/node_modules\//, /\.preval\./, /^[!@#$%^&*()=+~` + "`" + `-]/]`

Array of file patterns (strings or RegExp) to exclude from privacy transforms. By default, `node_modules`, `.preval.` files, and files starting with special characters are excluded.

### rum.privacy.addToDictionaryFunctionName

> default: `'$'`

The function name injected into transformed code to register strings with the privacy dictionary.

### rum.privacy.helperCodeExpression

> default: an IIFE that creates and manages the privacy dictionary queue on `globalThis`.

Custom JavaScript expression for the privacy helper code. Override this only if you need to customize how the privacy dictionary queue is initialized.

## Source Code Context

Inject source code context metadata so Datadog can link RUM errors to the correct source version.

### rum.sourceCodeContext.service

> required

The service name to associate with the source code context. Used by Datadog to link RUM data to the correct service.

### rum.sourceCodeContext.version

> optional

The version string to associate with this build. When omitted, Datadog uses other available version information.
