# Custom Hooks Plugin <!-- #omit in toc -->

Custom hooks for the build-plugins ecosystem.

If your plugin is producing something that will be shared with other plugins,<br/>
you should create a custom hook to let other plugins use it as soon as it is available.

<!-- #toc -->
-   [Create a custom hook](#create-a-custom-hook)
-   [Subscribe to a custom hook](#subscribe-to-a-custom-hook)
-   [Existing hooks](#existing-hooks)
    -   [Build Report](#build-report)
    -   [Bundler Report](#bundler-report)
    -   [Git](#git)
    -   [Metrics](#metrics)
    -   [True End](#true-end)
<!-- #toc -->

## Create a custom hook

1. Add your new hook to the [`CustomHooks` interface in `./src/types.ts`](/packages/core/src/types.ts).:

```typescript
export type CustomHooks = {
    // [...]
    myCustomSyncHook?: HookFn<[MyData]>;
    // or
    myCustomAsyncHook?: AsyncHookFn<[MyData]>;
};
```

2. Call your hook through the context when the data is available.

```typescript
// If it is an asynchronous hook
await context.asyncHook('myCustomAsyncHook', data);
// If it is a synchronous hook
context.hook('myCustomSyncHook', data);
```

> [!NOTE]
> When you want to create a custom hook, you should use `await context.asyncHook()` whenever you can, as it is more permissive and flexible.
> But it can only be used from another async hook.
> If you're creating a custom hook from a sync hook, you don't have a choice but to use `context.hook()`

3. Document it on your plugin's README.md file under a `## Hooks` section, explaining when it triggers and what it is useful for.

````md
## Hooks

### `myCustomSyncHook`

This hook is called when the data is available.

```typescript
{
    name: 'my-plugin',
    myCustomSyncHook(data: MyData) {
        // Do something with the data
    }
}
```
````

> [!NOTE]
> If the context allows you to, prefer using async hooks over sync hooks.
> This way, subscribers can use them both synchronously and asynchronously.

## Subscribe to a custom hook

If your plugin is dependent on some other plugin's custom hook, you can use it from your plugin's definition:

```typescript
{
    name: 'my-plugin',
    myCustomSyncHook(data) {
        // Do something with the data
    },
    async myCustomAsyncHook(data) {
        // Do something with the data
    }
}
```

> [!NOTE]
> - Data sent through the hooks are usually mutable, except for primitives.
> - Hooks are typed `void` by default, so you don't have to return anything.

## Existing hooks

<!-- #list-of-hooks -->
### Build Report

> [📝 Full documentation ➡️](/packages/plugins/build-report#hooks)

#### `buildReport`

This hook is called when the build report has been generated.<br/>
It is useful to get the current build's dependency graph for instance.
Happens during the `writeBundle` hook.

```typescript
{
    name: 'my-plugin',
    buildReport(report: BuildReport) {
        // Do something with the data
    }
}
```

### Bundler Report

> [📝 Full documentation ➡️](/packages/plugins/bundler-report#hooks)

#### `bundlerReport`

This hook is called when the bundler report is generated.<br/>
It is useful to get the current bundler's configuration for instance.

```typescript
{
    name: 'my-plugin',
    bundlerReport(report: BundlerReport) {
        // Do something with the data
    }
}
```

#### `buildRoot`

This hook is called when the build root directory is computed.<br/>

```typescript
{
    name: 'my-plugin',
    buildRoot(buildRoot: string) {
        // Do something with the data
    }
}
```

### Git

> [📝 Full documentation ➡️](/packages/plugins/git#hooks)

#### `git`

This hook is called when the git repository data is computed.

```typescript
{
    name: 'my-plugin',
    async git(git: RepositoryData) {
        // Do something with the data
    }
}
```

### Metrics

> [📝 Full documentation ➡️](/packages/plugins/metrics#hooks)

#### `metrics`

This hook is called when the metrics are aggregated and before they are sent to Datadog.

```typescript
{
    name: 'my-plugin',
    async metrics(metrics: Set<MetricToSend>) {
        // Do something with the metrics
    }
}
```

#### `timings`

This hook is called when the timings are aggregated.

```typescript
{
    name: 'my-plugin',
    async timings(timings: TimingsReport) {
        // Do something with the timings
    }
}
```

### True End

> [📝 Full documentation ➡️](/packages/plugins/true-end#hooks)

#### `asyncTrueEnd`

This hook is called at the very end of the build asynchronously.

It may execute sooner than `syncTrueEnd` in some contexts:

- `esbuild` will call `asyncTrueEnd` before `syncTrueEnd`.
    - We use `build.onDispose`, for the latest hook possible in the build. The issue is, it's synchronous only. So we have to use `build.onEnd` for the asynchronous `asyncTrueEnd`, but it's called well before `build.onDispose`.

```typescript
{
    name: 'my-plugin',
    async asyncTrueEnd() {
        // Do something asynchronous on closure
        await someAsyncOperation();
    }
}
```

#### `syncTrueEnd`

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

<!-- #list-of-hooks -->
