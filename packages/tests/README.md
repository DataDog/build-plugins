# Tests

All the workspaces are tested in here.<br/>
It helps us have a better control over the test specific dependencies.

Especially useful for having mock projects, built with specific bundlers and run the real thing.

## Run all the tests

```bash
yarn test
```

## Run all the tests with all the logs

By default, jest is in silent mode and won't show any logs.

```bash
yarn test:noisy
```

## Debug a test

You can target a single file the same as if you were using Jest's CLI.

Within your test you can then use `.only` or `.skip` to target a single test in particular.

```bash
yarn test:noisy packages/tests/...
```

## Test a plugin

Once you have your plugin ready, you can test it in two ways, both are not exclusive.

The **unit** way, where you test each functions individually, verifying that given an input you get the expected output.<br/>
This doesn't need much explanation as it is pretty straight-forward.

Or the **integration** way, which will test the plugin within the whole ecosystem, but is a bit more involved to setup correctly.<br/>
Let's talk about this a bit more.

### Bootstrapping your test

Here's a bootstrap to get you going:

```typescript
import type { Options } from '@dd/core/types';
import type { CleanupFn } from '@dd/tests/helpers/runBundlers';
import { runBundlers } from '@dd/tests/helpers/runBundlers';

describe('My very awesome plugin', () => {
    let cleanup: CleanupFn;

    beforeAll(async () => {
        const pluginConfig: Options = {
            // Add your config in order to enable your plugin in the build.
            myNewPlugin: {},
        };
        // Run the build on our basic default project.
        cleanup = await runBundlers(pluginConfig);
    });

    afterAll(async () => {
        // Clean the generated files (in a seeded directory).
        await cleanup();
    });

    test('Should have done something', () => {
        expect(true).toBe(false);
    });
});
```

### Bundlers

We currently support `webpack4`, `webpack5`, `esbuild`, `rollup` and `vite`.<br/>
So we need to ensure that our plugins works everywhere.

When you use `runBundlers()` in your setup (usually `beforeAll()`), it will run a build on [a very basic default mock project](/packages/tests/src/fixtures/main.js).<br/>
Since it's building in a seeded directory, to avoid any collision, it will also return a cleanup function, that you'll need to use in your teardown (usually `afterAll()`).

During development, you may want to target a specific bundler, to reduce noise from the others.<br/>
For this, you can use `--bundlers=<name>,<name>` options when running your tests:

```bash
yarn test:noisy packages/tests/... --bundlers=webpack4,esbuild
```

### More complex projects

We also have [a more complex project](/packages/tests/src/fixtures/project), with third parties dependencies for instance, that you can use with the `getComplexBuildOverrides()` function.<br/>
To be used as follow:

```typescript
import { getComplexBuildOverrides } from '@dd/tests/helpers/mocks';

[...]

cleanup = await runBundlers(pluginConfig, getComplexBuildOverrides());
```

If that's still not enough, we have a dynamic project generator too.<br/>
You can generate any size of project you want with `generateProject(nbEntries, nbModules);`.<br/>
It will return the array of entries it created.

Here's how you'd go with it:

```typescript
import { getWebpack4Entries } from '@dd/tests/helpers/configBundlers';
import { generateProject } from '@dd/tests/helpers/generateMassiveProject';
import { defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { runBundlers } from '@dd/tests/helpers/runBundlers';

describe('Some very massive project', () => {
    beforeAll(async () => {
        const entries = await generateProject(2, 500);
        // Override the default bundler configuration with the new entries.
        const bundlerOverrides = {
            rollup: {
                input: entries,
            },
            vite: {
                input: entries,
            },
            esbuild: {
                entryPoints: entries,
            },
            // Mode production makes the build waaaaayyyyy too slow.
            webpack5: { mode: 'none', entry: entries },
            webpack4: {
                mode: 'none',
                // Webpack4 needs some help for pnp resolutions.
                entry: getWebpack4Entries(entries),
            },
        };

        cleanup = await runBundlers(defaultPluginOptions, bundlerOverrides);
    });

    afterAll(async () => {
        await cleanup();
    });
});
```

### Work with the global context

The global context is pretty nifty to share data between plugins.<br/>
But, it is a mutable object, so you'll have to keep that in mind when testing around it.

The best way would be to freeze the content you need to test, at the moment you want to test it:

```typescript
import type { GlobalContext, Options } from '@dd/core/types';
import { defaultPluginOptions } from '@dd/tests/helpers/mocks';
import type { CleanupFn } from '@dd/tests/helpers/runBundlers';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';

describe('Global Context Plugin', () => {
    const initialContexts: Record<string, GlobalContext> = {};
    let cleanup: CleanupFn;

    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at the moment they're used.
            customPlugins: (opts, context) => {
                const bundlerName = context.bundler.fullName;
                // Freeze the context here.
                initialContexts[bundlerName] = JSON.parse(JSON.stringify(context));
                return [];
            },
        };

        cleanup = await runBundlers(pluginConfig);
    });

    afterAll(async () => {
        await cleanup();
    });

    test.each(BUNDLERS)('[$name|$version] Test basic info.', ({ name }) => {
        const context = initialContexts[name];
        expect(context).toBeDefined();
    });
});
```

The issue is that some part of the context are not serialisable.<br/>
So, following the same technique, you should only pick and store the part you need from the context.<br/>
And individually serialise the parts that need to.<br/>
For the `context.build` for instance, you can use the helpers `serializeBuildReport(context.build)` and `unserializeBuildReport(serializedReport)` in order to deep clone it:

```typescript
buildReports[bundlerName] = unserializeBuildReport(serializeBuildReport(context.build));
```
