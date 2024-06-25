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
        intakeUrl?: string;
        maxConcurrency?: number;
        minifiedPathPrefix?: string;
        releaseVersion: string;
        service: string;
    };
}
```

> [!NOTE]
> You can override the intake URL by setting the `DATADOG_SOURCEMAP_INTAKE_URL` environment variable (eg. `https://sourcemap-intake.datadoghq.com/v1/input`).
> Or only the domain with the `DATADOG_SITE` environment variable (eg. `datadoghq.com`).
