# Output Plugin <!-- #omit in toc -->

Export build reports, metrics, and bundler data to JSON files for analysis and monitoring.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
    -   [`enable`](#enable)
    -   [`path`](#path)
    -   [`files`](#files)
-   [Examples](#examples)
<!-- #toc -->

## Configuration

```ts
output?: {
    enable?: boolean;
    path?: string;
    files?: {
        build?: boolean | string;
        bundler?: boolean | string;
        dependencies?: boolean | string;
        errors?: boolean | string;
        logs?: boolean | string;
        metrics?: boolean | string;
        timings?: boolean | string;
        warnings?: boolean | string;
    };
}
```

### `enable`

> default: `true`

Enable or disable the output plugin.

### `path`

> default: `'./'`

Base directory for output files. Can be relative to the build output directory or an absolute path.

### `files`

> default: All files enabled

Control which files to output and their names. Each property accepts:
- `true`: Output with default filename
- `false`: Do not output this file
- `string`: Output with custom filename

| Property        | Output File           | Description                                                                                            |
| :-------------- | :-------------------- | :----------------------------------------------------------------------------------------------------- |
| `build`         | `build.json`          | Comprehensive build information including bundler details, metadata, timing, and file outputs          |
| `bundler`       | `bundler.json`        | Bundler-specific data (metafile for esbuild, stats for webpack/rspack, bundle info for rollup/vite)    |
| `dependencies`  | `dependencies.json`   | Input files dependency tree                                                                            |
| `errors`        | `errors.json`         | Array of build errors                                                                                  |
| `logs`          | `logs.json`           | Build process logs                                                                                     |
| `metrics`       | `metrics.json`        | Build metrics (when available)                                                                         |
| `timings`       | `timings.json`        | For the supported bundlers, will contain some build timings                                            |
| `warnings`      | `warnings.json`       | Array of build warnings                                                                                |

## Examples

Enable all outputs with defaults:

```javascript
{
    output: {}
}
```

Custom output directory:

```javascript
{
    output: {
        path: './reports'
    }
}
```

Selective outputs with custom filenames:

```javascript
{
    output: {
        path: './reports',
        files: {
            build: true, // Will output ./reports/build.json
            errors: 'build-errors.json', // Will output ./reports/build-errors.json
            warnings: 'build-warnings.json' // Will output ./reports/build-warnings.json
            // The other files won't be produced.
        }
    }
}
```
