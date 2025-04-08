# Synthetics Plugin <!-- #omit in toc -->

Interact with Synthetics at build time.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Build and test](#build-and-test)
<!-- #toc -->

## Configuration

```ts
synthetics?: {
    disabled?: boolean;
}
```

## Build and test

Using [`datadog-ci`'s `synthetics build-and-test` command](https://github.com/DataDog/datadog-ci/tree/master/src/commands/synthetics#run-tests-command),
you can have the build spin a dev server to serve the outdir of the build in order [to trigger a CI batch](https://docs.datadoghq.com/continuous_testing/) over the branch's code.
