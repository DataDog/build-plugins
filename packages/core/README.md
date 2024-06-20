# Datadog Build Plugins Core

A set of core functionalities to use within the Datadog Build Plugins.

## Plugins

### Global Context

Offers to share a global context between all the plugins.

```typescript
type GlobalContext = {
    cwd: string;
    version: string;
    bundler: {
        name: string;
        config?: any;
    };
};
```

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
