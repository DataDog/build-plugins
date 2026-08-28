# Apps Plugin <!-- #omit in toc -->

A Vite plugin that builds a deployable Datadog Apps package. Publishing is owned by `@datadog/apps-cli`.

> [!WARNING]
> The Apps plugin is in **alpha** and is likely to break in most setups.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [Package output](#package-output)
    -   [apps.enable](#appsenable)
    -   [apps.include](#appsinclude)
    -   [apps.identifier](#appsidentifier)
    -   [apps.name](#appsname)
    -   [apps.description](#appsdescription)
    -   [apps.selfService](#appsselfservice)
    -   [apps.permissions](#appspermissions)
<!-- #toc -->

## Configuration

```ts
apps?: {
    enable?: boolean;
    include?: string[];
    identifier?: string;
    name?: string;
    description?: string;
    selfService?: boolean;
    permissions?: {
        protectionLevel?: 'direct_publish' | 'approval_required';
        runAs?: string;
    };
    authOverrides?: {
        method?: 'apiKey' | 'oauth';
    };
}
```

## Package output

A production `vite build` writes `datadog-apps-assets.zip` and `datadog-apps-build.json` beside the Vite output. The ZIP contains `frontend/`, `backend/`, and `manifest.json`; the sidecar supplies schema version, bundle filename, identifier, and name for the CLI handoff.

Set `DATADOG_APPS_PACKAGE_DIR` (or `DD_APPS_PACKAGE_DIR`) to write both files to a different directory. `DATADOG_APPS_IDENTIFIER`/`DD_APPS_IDENTIFIER` and `DATADOG_APPS_NAME`/`DD_APPS_NAME` override the resolved identity for a CLI child build.

Use `datadog-apps build` to package locally, `datadog-apps upload` to create a draft, and `datadog-apps deploy` to upload and publish. Production packaging makes no Datadog API requests. Development-server backend functions retain their existing authentication behavior.

### apps.enable

> default: `true` when an `apps` config block is present, `false` otherwise.

Enable or disable the plugin without removing its configuration.

### apps.include

> default: `[]`

Additional glob patterns (relative to the project root) to include in the package. The bundler output directory is always included.

### apps.identifier

> default: computed from the app name and repository.

Override the app identifier. Environment identity overrides take precedence over this setting during an Apps CLI child build.

### apps.name

> default: extracted from the `name` field in `package.json`.

Override the human-readable app name. Environment identity overrides take precedence over this setting during an Apps CLI child build.

### apps.description

Human-readable description included in the package manifest.

### apps.selfService

When true, the app appears in the Datadog self-service catalog.

### apps.permissions

`protectionLevel` controls direct publication versus approval requirements, and `runAs` identifies the service account that executes backend functions.
