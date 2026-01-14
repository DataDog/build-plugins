# Logs Plugin <!-- #omit in toc -->

Send build logs to Datadog.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Options](#options)
    -   [logs.service](#logsservice)
    -   [logs.env](#logsenv)
    -   [logs.tags](#logstags)
    -   [logs.logLevel](#logsloglevel)
    -   [logs.includeBundlerLogs](#logsincludebundlerlogs)
    -   [logs.includePluginLogs](#logsincludepluginlogs)
    -   [logs.includeModuleEvents](#logsincludemoduleevents)
    -   [logs.includeTimings](#logsincludetimings)
    -   [logs.batchSize](#logsbatchsize)
-   [Log Sources by Bundler](#log-sources-by-bundler)
<!-- #toc -->

## Configuration

```ts
logs?: {
    enable?: boolean;
    service?: string;
    env?: string;
    tags?: string[];
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none';
    includeBundlerLogs?: boolean;
    includePluginLogs?: boolean;
    includeModuleEvents?: boolean;
    includeTimings?: boolean;
    batchSize?: number;
}
```

> [!NOTE]
> You can override the intake URL by setting the `DATADOG_LOGS_INTAKE_URL` or `DD_LOGS_INTAKE_URL` environment variable.

## Options

### logs.service

> default: `'build-plugins'`

The service name to attach to all logs. This will appear in Datadog Logs under the `service` facet.

### logs.env

> default: `undefined`

The environment tag to attach to all logs. This will appear in Datadog Logs under the `env` facet.

### logs.tags

> default: `[]`

Additional tags to attach to all logs. Tags should be in the format `key:value`.

```ts
logs: {
    tags: ['team:frontend', 'project:my-app', 'version:1.0.0']
}
```

### logs.logLevel

> default: `'debug'`

Minimum log level to send to Datadog. Logs below this level will be filtered out.

| Value | Logs sent |
|-------|-----------|
| `'debug'` | debug, info, warn, error |
| `'info'` | info, warn, error |
| `'warn'` | warn, error |
| `'error'` | error only |
| `'none'` | no logs sent |

### logs.includeBundlerLogs

> default: `true`

Include logs from the bundler itself (errors, warnings, and build summaries).

For Webpack/Rspack, this includes:
- Compilation errors and warnings
- Build timing information
- Asset and chunk summaries
- Webpack's internal logging

For Rollup/Vite, this includes:
- `onLog` hook events (debug, info, warn levels)
- `renderError` hook events

For ESBuild, this includes:
- Build errors and warnings from `result.errors` and `result.warnings`

### logs.includePluginLogs

> default: `true`

Include internal logs from all Datadog build plugins. These logs provide insight into what the plugins are doing during the build process.

### logs.includeModuleEvents

> default: `false`

Include module-level events as debug logs. This can generate a large number of logs for projects with many modules.

> [!WARNING]
> Enabling this option can significantly increase the number of logs sent, especially for large projects. Use with caution.

| Bundler | Events captured |
|---------|-----------------|
| Rollup/Vite | `moduleParsed` - when a module is parsed |
| Webpack/Rspack | `buildModule`, `succeedModule` - module build lifecycle |
| ESBuild | `onResolve`, `onLoad` - module resolution and loading |

### logs.includeTimings

> default: `false`

Include timing data from all plugins as info-level logs. Each timing entry includes the label and duration in milliseconds.

### logs.batchSize

> default: `100`

Number of logs to send per API request. Logs are batched for efficiency. Increase this value if you have many logs to reduce the number of API calls.

## Log Sources by Bundler

Each bundler provides different log sources:

| Bundler | Debug/Info | Warnings/Errors | Module Events |
|---------|------------|-----------------|---------------|
| **Rollup** | `onLog()` hook | `onLog()`, `renderError()` | `moduleParsed()` |
| **Vite** | `onLog()` hook | `onLog()`, `renderError()` | `moduleParsed()` |
| **Webpack** | `stats` logging | `compilation.errors/warnings` | `buildModule`, `succeedModule` |
| **Rspack** | `stats` logging | `compilation.errors/warnings` | `buildModule`, `succeedModule` |
| **ESBuild** | - | `result.errors/warnings` | `onResolve`, `onLoad` |
