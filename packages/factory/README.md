# Factory <!-- #omit in toc -->

This is used to aggregate all the plugins and expose them to the bundler.

> [!NOTE]
> We use [unplugin](https://unplugin.unjs.io/) to support many different bundlers.

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Internal Plugins](#internal-plugins)
    -   [Analytics](#analytics)
    -   [Build Report](#build-report)
    -   [Bundler Report](#bundler-report)
    -   [Custom Hooks](#custom-hooks)
    -   [Git](#git)
    -   [Injection](#injection)
-   [Logger](#logger)
-   [Time Logger](#time-logger)
    -   [Options](#options)
    -   [Features](#features)
-   [Global Context](#global-context)
-   [Hooks](#hooks)
    -   [`init`](#init)
<!-- #toc -->

## Internal Plugins

These are the plugins that are used internally by the factory.
Most of the time they will interact via the global context.

<!-- #internal-plugins-list -->
### Analytics

> Send some analytics data to Datadog internally.
> <br/>
> It gives you acces to the `context.sendLog()` function.

#### [📝 Full documentation ➡️](/packages/plugins/analytics#readme)


### Build Report

> This will populate `context.build` with a bunch of data coming from the build.

#### [📝 Full documentation ➡️](/packages/plugins/build-report#readme)


### Bundler Report

> A very basic report on the currently used bundler.<br/>
> It is useful to unify some configurations.

#### [📝 Full documentation ➡️](/packages/plugins/bundler-report#readme)


### Custom Hooks

> Custom hooks for the build-plugins ecosystem.
> <br/>
> If your plugin is producing something that will be shared with other plugins,<br/>
> you should create a custom hook to let other plugins use it as soon as it is available.

#### [📝 Full documentation ➡️](/packages/plugins/custom-hooks#readme)


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
export const getMyPlugins = (context: GlobalContext) => {
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

## Time Logger

The time logger is a helper to log/report the duration of a task.
It is useful to debug performance issues.

It can be found in your logger.

```typescript
const log = context.getLogger('my-plugin');
const timer = log.time('my-task');
// [... do stuff ...]
timer.end();
```

### Options

- `start`: Whether to start the timer immediately. Defaults to `true`.
- `log`: Whether to log the timer. Defaults to `true`.
- `level`: The log level to use. Defaults to `debug`.
- `tags`: Initial tags to associate with the timer. Defaults to `[]`.

```typescript
{
    start: boolean,
    log: boolean,
    level: LogLevel,
    tags: string[]
}
```

### Features

Pause/resume the timer.

```typescript
timer.pause();
// [... do stuff ...]
timer.resume();
// [... do more stuff ...]
timer.end();
```

Add tags to the timer or to active spans.

```typescript
// Add tags to the entire timer
timer.tag(['feature:upload', 'operation:compress']);

// Add tags to the current active span only
timer.tag(['step:initialize'], { span: true });
```

Use it with a specific log level.

```typescript
const timer = log.time('my-task', { level: 'error' });
// [... do stuff ...]
timer.end();
```

Initialize with tags.

```typescript
const timer = log.time('my-task', { tags: ['type:report', 'priority:high'] });
// [... do stuff ...]
timer.end();
```

Make it not auto start.

```typescript
const timer = log.time('my-task', { start: false });
// [... do stuff ...]
// This will start the timer.
timer.resume();
// [... do more stuff ...]
timer.end();
```

Make it not log.

```typescript
const timer = log.time('my-task', { log: false });
// [... do stuff ...]
timer.end();
```

All the timers will be reported in `context.build.timings`, with all their spans and total durations.

```json
{
    "timings": [
        {
            "label": "my-task",
            "pluginName": "my-plugin",
            "spans": [
                {
                    "start": 1715438400000,
                    "end": 1715438401000,
                    "tags": ["step:initialize"]
                }
            ],
            "tags": ["feature:upload", "operation:compress"],
            "total": 1000,
            "logLevel": "debug"
        }
    ]
}
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

## Hooks

### `init`

This hook is called when the factory is done initializing.<br/>
It is useful to initialise some global dependencies.
Happens before any other hook.

```typescript
{
    name: 'my-plugin',
    init(context: GlobalContext) {
        // Do something with the data
    }
}
```
