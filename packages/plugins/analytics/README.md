# Analytics Plugin <!-- #omit in toc -->

Send some analytics data to Datadog internally.

It gives you acces to the `context.sendLog()` function.

```typescript
// Send a basic log.
context.sendLog('My basic log');

// Send some context with the log.
context.sendLog('My contextual log', { some: 'context' });
```

Every log already has some context to it:

```typescript
{
    ddsource: string; // Name of the bundler plugin (e.g. `@datadog/webpack-plugin`).
    env: Env; // Environment (e.g. `production`).
    message; // The log message.
    service: 'build-plugins';
    bundler: {
        name: string; // Name of the bundler (e.g. `webpack`).
        version: string; // Version of the bundler.
    };
    plugins: PluginName[]; // List of the plugins/features enabled.
    version: string; // Version of the plugin.
}
```
