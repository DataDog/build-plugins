# True End Plugin <!-- #omit in toc -->

A custom hook for the true end of a build, cross bundlers.

## Hooks

### `asyncTrueEnd`

This hook is called at the very end of the build asynchronously.

It may execute sooner than `syncTrueEnd` in some contexts:

- `esbuild` will call `asyncTrueEnd` before `syncTrueEnd`.
    - We use `build.onDispose`, for the latest hook possible in the build. The issue is, it's synchronous only. So we have to use `build.onEnd` for the asynchronous `asyncTrueEnd`, but it's called well before `build.onDispose`.
- `webpack 4` will only call `syncTrueEnd` if the build has an error. All good otherwise.

```typescript
{
    name: 'my-plugin',
    async asyncTrueEnd() {
        // Do something asynchronous on closure
        await someAsyncOperation();
    }
}
```

### `syncTrueEnd`

This hook is called at the very end of the build synchronously.

```typescript
{
    name: 'my-plugin',
    syncTrueEnd() {
        // Do something synchronous on closure
        someSyncOperation();
    }
}
```
