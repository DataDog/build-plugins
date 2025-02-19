# Factory <!-- #omit in toc -->

This is used to aggregate all the plugins and expose them to the bundler.

> [!NOTE]
> We use [unplugin](https://unplugin.unjs.io/) to support many different bundlers.

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Internal Plugins](#internal-plugins)
    -   [Build Report](#build-report)
    -   [Bundler Report](#bundler-report)
    -   [Git](#git)
    -   [Injection](#injection)
-   [Logger](#logger)
-   [Global Context](#global-context)
<!-- #toc -->

## Internal Plugins

These are the plugins that are used internally by the factory.
Most of the time they will interact via the global context.

<!-- #internal-plugins-list -->
### Build Report

> This will populate `context.build` with a bunch of data coming from the build.

#### [📝 Full documentation ➡️](/packages/plugins/build-report#readme)


### Bundler Report

> A very basic report on the currently used bundler.<br/>
> It is useful to unify some configurations.

#### [📝 Full documentation ➡️](/packages/plugins/bundler-report#readme)


### Git

> Adds repository data to the global context from the `buildStart` hook.

#### [📝 Full documentation ➡️](/packages/plugins/git#readme)


### Injection

> This is used to inject some code to the produced bundle.<br/>
> Particularly useful :
> - to share some global context.
> - to automatically inject some SDK.
> - to initialise some global dependencies.
> - ...

#### [📝 Full documentation ➡️](/packages/plugins/injection#readme)

<!-- #internal-plugins-list -->

## Logger

If you need to log anything into the console you'll have to use the global Logger.
You can get a logger by calling `context.getLogger(PLUGIN_NAME);`.

```typescript
// ./packages/plugins/my-plugin/index.ts
[...]

export const getMyPlugins = (context: GlobalContext) => {
    const log = context.getLogger(PLUGIN_NAME);
    log.debug('Welcome to my plugin');
    [...]
};
```

Then you can either use one of the level logger methods:

```typescript
logger.warn('This is also a warning');
logger.error('This is an error');
logger.info('This is an info');
logger.debug('This is a debug message');
```

You can also create a "sub-logger" when you want to individually identify logs from a specific part of your plugin.<br/>
Simply use `log.getLogger('my-plugin')` for this:

```typescript
export const getMyPlugins = (context: GlobalContext) => 
    const log = context.getLogger(PLUGIN_NAME);
    log.debug('Welcome to the root of my plugin');
    return [
        {
            name: 'my-plugin',
            setup: (context: PluginContext) => {
                const subLog = log.getLogger('my-plugin');
                subLog.info('This is a debug message from one of my plugins.');
            },
        },
    ];
};
```

## Global Context

A global, shared context within the build plugins ecosystem.<br/>
It is passed to your plugin's initialization, and **is mutated during the build process**.

<!-- Using "pre" to use links -->
<pre>
type GlobalContext = {
    // Mirror of the user's config.
    auth?: {
        apiKey?: string;
    };
    // More details on the currently running bundler.
    bundler: <a href="/packages/plugins/bundler-report#readme" title="BundlerReport">BundlerReport</a>
    // Added in `writeBundle`.
    build: <a href="/packages/plugins/build-report#readme" title="BuildReport">BuildReport</a>
    cwd: string;
    getLogger: (name: string) => <a href="#logger" title="Logger">Logger</a>
    // Added in `buildStart`.
    git?: <a href="/packages/plugins/git#readme" title="Git">Git</a>
    inject: <a href="/packages/plugins/injection#readme" title="Injection">Injection</a>
    start: number;
    version: string;
}
</pre>

> [!NOTE]
> Some parts of the context are only available after certain hooks:
>   - `context.bundler.rawConfig` is added in the `buildStart` hook.
>   - `context.build.*` is populated in the `writeBundle` hook.
>   - `context.git.*` is populated in the `buildStart` hook.

Your function will need to return an array of [Unplugin Plugins definitions](https://unplugin.unjs.io/guide/#supported-hooks).
