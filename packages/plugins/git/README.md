# Git Plugin <!-- #omit in toc -->

Adds repository data to the global context from the `buildStart` hook.

```typescript
{
    // Added to the global context.
    git?: {
        hash: string;
        remote: string;
        trackedFilesMatcher: [TrackedFilesMatcher](/packages/plugins/git/src/trackedFilesMatcher.ts) {
            matchSourcemap: (path: string, onSourceFound: (): void): string[];
            matchSources: (sources: string[]): string[];
            rawTrackedFilesList: (): string[];
        };
    }
}
```

> [!NOTE]
> This won't be added if [`options.enableGit = false`](/#enablegit).

## Hooks

### `git`

This hook is called when the git repository data is computed.

```typescript
{
    name: 'my-plugin',
    async git(git: RepositoryData) {
        // Do something with the data
    }
}
```
