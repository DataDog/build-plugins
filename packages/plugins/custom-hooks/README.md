# Custom Hooks Plugin <!-- #omit in toc -->

Custom hooks for the build-plugins ecosystem.

If your plugin is producing something that will be shared with other plugins,<br/>
you should create a custom hook to let other plugins use it as soon as it is available.

## Create a custom hook

1. Add your new hook to the [`CustomHooks` interface in `./src/types.ts`](/packages/core/src/types.ts).:
2. Call your hook through the context when the data is available.

```typescript
// If it is a synchronous hook
context.hook('myCustomSyncHook', data);

// If it is an asynchronous hook
await context.asyncHook('myCustomAsyncHook', data);
```

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
