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

Use [`options.gitRepositoryUrl`](/#gitrepositoryurl) to override the repository identity when a CI checkout uses a mirror or has no remote. The commit and tracked files still come from the local checkout.

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
