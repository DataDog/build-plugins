# Datadog Build Plugins Core

A set of core functionalities to use within the Datadog Build Plugins ecosystem.

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
<!-- #toc -->

## Global Context

Use a global, shared context within the build plugins ecosystem.

```typescript
type GlobalContext = {
    // Mirror of the user's config.
    auth?: {
        apiKey?: string;
    };
    // More details on the currently running bundler.
    bundler: {
        name: string;
        fullName: string; // Including its variant.
        outDir: string; // Output directory
        // Added in `buildStart`.
        rawConfig?: any;
        variant: string; // Major version of the bundler (webpack 4, webpack 5)
    };
    // Added in `writeBundle`.
    build: {
        errors: string[];
        warnings: string[];
        entries?: { filepath: string; name: string; size: number; type: string, inputs: Input[], outputs: Output[] }[];
        inputs?: { filepath: string; name: string; size: number; type: string, dependencies: Input[]; dependents: Input[] }[];
        outputs?: { filepath: string; name: string; size: number; type: string, inputs: (Input | Output)[] }[];
        start?: number;
        end?: number;
        duration?: number;
        writeDuration?: number;
    };
    cwd: string;
    // Added in `buildStart`.
    git?: {
        hash: string;
        remote: string;
        trackedFilesMatcher: [TrackedFilesMatcher](packages/core/src/plugins/git/trackedFilesMatcher.ts);
    };
    inject: (item: { type: 'file' | 'code'; value: string; fallback?: @self }) => void;
    start: number;
    version: string;
}
```

> [!NOTE]
> Some parts of the context are only available after certain hooks as stated above.

## Plugins

### Build Report

### Bundler Report

### Git Plugins

Adds repository data to the global context.

```typescript
{
    // Added to the global context.
    git?: {
        hash: string;
        remote: string;
        trackedFilesMatcher: {
            matchSourcemap: (path: string, onSourceFound: (): void): string[];
            matchSources: (sources: string[]): string[];
            rawTrackedFilesList: (): string[];
        };
    }
}
```

> [!NOTE]
> This won't be added if `options.disabledGit = true` or `options.rum.sourcemaps.disabledGit = true`.

### Injection Plugin
