# RUM Plugin <!-- #omit in toc -->

Interact with our Real User Monitoring product (RUM) in Datadog directly from your build system.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
<!-- #toc -->

## Configuration

```ts
rum?: {
    disabled?: boolean;
    sourcemaps?: {
        basePath: string;
        dryRun?: boolean;
        maxConcurrency?: number;
        minifiedPathPrefix?: string;
        releaseVersion: string;
        service: string;
    };
}
```
