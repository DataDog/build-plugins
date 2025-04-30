# True End Plugin <!-- #omit in toc -->

A custom hook for the true end of a build, cross bundlers.

## Hooks

### `asyncTrueEnd`

This hook is called at the very end of the build asynchronously.

It may execute sooner than `syncTrueEnd` in some contexts:

- `esbuild` will call `asyncTrueEnd` before `syncTrueEnd`, because `build.onDispose` is synchronous while `build.onEnd`, which is called prior, is asynchronous.
- `webpack 4` will only call `syncTrueEnd` in case of an error in the build.

```typescript
{
    name: 'my-plugin',
    async asyncTrueEnd() {
        // Do something on closure
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
        // Do something on closure
        // Note: 'await' cannot be used in a synchronous function
        someSyncOperation();
    }
}
```
