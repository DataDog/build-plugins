# Git Plugin <!-- #omit in toc -->

Adds repository data to the global context from the `buildStart` hook.

```typescript
{
    // Added to the global context.
    git?: {
        hash: string;
        remote: string;
        trackedFilesMatcher: [TrackedFilesMatcher](/packages/plugins/git/trackedFilesMatcher.ts) {
            matchSourcemap: (path: string, onSourceFound: (): void): string[];
            matchSources: (sources: string[]): string[];
            rawTrackedFilesList: (): string[];
        };
    }
}
```

> [!NOTE]
> This won't be added if [`options.disabledGit = true`](/#disablegit) or [`options.errorTracking.sourcemaps.disabledGit = true`](/packages/plugins/error-tracking#errortrackingsourcemapsdisablegit).
