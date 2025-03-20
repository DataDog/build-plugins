# Tests <!-- #omit in toc -->

All the workspaces are tested in here.<br/>
It helps us have a better control over the test specific dependencies.

Especially useful for having mock projects, built with specific bundlers and run the real thing.

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Unit tests](#unit-tests)
    -   [Run](#run)
    -   [Debug](#debug)
    -   [Test a plugin](#test-a-plugin)
-   [End to End tests](#end-to-end-tests)
    -   [Run](#run)
    -   [Debug](#debug)
<!-- #toc -->

## Unit tests

### Run

```bash
yarn test:unit
```

You can use [jest flags](https://jestjs.io/docs/cli) directly after the command.

### Debug

You can target a single file the same as if you were using Jest's CLI.

Within your test you can then use `.only` or `.skip` to target a single test in particular.

```bash
yarn test:unit packages/...
```

### Test a plugin

Once you have your plugin ready, you can test it in two ways, both are not exclusive.

The **unit** way, where you test each function individually, verifying that given an input you get the expected output.<br/>
This doesn't need much explanation as it is pretty straight-forward.

Or the **integration** way, which will test the plugin within the whole ecosystem, but is a bit more involved to setup correctly.<br/>
Let's talk about this a bit more.

#### Bootstrapping your test

Here's a bootstrap to get you going:

```typescript
import type { Options } from '@dd/core/types';
import { runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('My very awesome plugin', () => {
    beforeAll(async () => {
        const pluginConfig: Options = {
            // Add your config in order to enable your plugin in the build.
            myNewPlugin: {},
        };
        // Run the build on our basic default project.
        await runBundlers(pluginConfig);
    });

    test('Should have done something', () => {
        expect(true).toBe(false);
    });
});
```

#### Bundlers

We currently support `webpack4`, `webpack5`, `rspack`, `esbuild`, `rollup` and `vite`.<br/>
So we need to ensure that our plugin works everywhere.

When you use `runBundlers()` in your setup (usually `beforeAll()`), it will run the build of [a very basic default mock project](/packages/tests/src/_jest/fixtures/easy_project/main.js).<br/>
Since it's building in a seeded directory, to avoid any collision, it will return:

```typescript
{
    errors: string[]; // It doesn't throw on build error, so you can use this to check for them.
    workingDir: string; // The temporary working directory of the build process.
}
```

During development, you may want to target a specific bundler, to reduce noise from the others.<br/>
For this, you can use the `--bundlers=<name>,<name>` flag when running your tests:

```bash
yarn test:unit packages/... --bundlers=webpack4,esbuild
```

If you want to keep the built files for debugging purpose, you can use the `--cleanup=0` parameter:

```bash
yarn test:unit packages/... --cleanup=0
```

If you want to also build the plugins for the bundlers you're targeting, you can use the `--build=1` parameter:

```bash
# Will also build both webpack and esbuild plugins before running the tests.
yarn test:unit packages/... --build=1 --bundlers=webpack4,esbuild
```

#### More complex projects

We also have [a more complex project](/packages/tests/src/_jest/fixtures/project), with third parties dependencies for instance, that you can use with the `getComplexBuildOverrides()` function.<br/>
To be used as follow:

```typescript
import { getComplexBuildOverrides } from '@dd/tests/_jest/helpers/mocks';

[...]

await runBundlers(pluginConfig, getComplexBuildOverrides());
```

If that's still not enough, we have a dynamic project generator too.<br/>
You can generate any size of project you want with `generateProject(nbEntries, nbModules);`.<br/>
It will return the array of entries it created.

Here's how you'd go with it:

```typescript
import { generateProject } from '@dd/tests/_jest/helpers/generateMassiveProject';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

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
            webpack4: { mode: 'none', entry: entries },
        };

        await runBundlers(defaultPluginOptions, bundlerOverrides);
    });
});
```

> [!NOTE]
> `generateProject()` is not persistent.
> So for now it's only to be used to debug your plugin when necessary.

#### Work with the global context

The global context is pretty nifty to share data between plugins.<br/>
But, it is a mutable object, so you'll have to keep that in mind when testing around it.

The best way would be to freeze the content you need to test, at the moment you want to test it, for instance, to capture the initial context using `JSON.parse(JSON.stringify(context.bundler))` to freeze it:

```typescript
import type { GlobalContext, Options } from '@dd/core/types';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('Global Context Plugin', () => {
    const initialContexts: Record<string, GlobalContext> = {};

    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at the moment they're used.
            customPlugins: (opts, context) => {
                const bundlerName = context.bundler.fullName;
                // Freeze the context here, to verify what's available during initialization.
                initialContexts[bundlerName] = JSON.parse(JSON.stringify(context.bundler));
                return [];
            },
        };

        await runBundlers(pluginConfig);
    });

    test.each(BUNDLERS)('[$name|$version] Test basic info.', ({ name }) => {
        const context = initialContexts[name];
        expect(context).toBeDefined();
    });
});
```

The issue is that some part of the context are not serialisable.

So, following the same technique, you should:

- only pick and store the parts you need from the context.
- individually serialise the parts that need to.

The `context.build` for instance, isn't serializable, but you can use the helpers `serializeBuildReport(context.build)` and `unserializeBuildReport(serializedReport)` in order to deep clone it:

```typescript
buildReports[bundlerName] = unserializeBuildReport(serializeBuildReport(context.build));
```

Giving the following, more involved example:

```typescript
import { serializeBuildReport, unserializeBuildReport } from '@dd/core/helpers/plugins';
import type { BuildReport, Options } from '@dd/core/types';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('Build Reports', () => {
    const buildReports: Record<string, BuildReport> = {};

    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at the moment they're used.
            customPlugins: (opts, context) => {
                const bundlerName = context.bundler.fullName;
                return [{
                    name: 'my-custom-plugin',
                    writeBundle() {
                        // Freeze the context here, to verify what's available after the writeBundle hook.
                        const serializedBuildReport = serializeBuildReport(context.build);
                        buildReports[bundlerName] = unserializeBuildReport(serializedBuildReport);
                    }
                }];
            },
        };

        await runBundlers(pluginConfig);
    });

    test.each(BUNDLERS)('[$name|$version] Have the build report.', ({ name }) => {
        const context = buildReports[name];
        expect(context).toBeDefined();
    });
});
```

## End to End tests

We use [Playwright](https://playwright.dev/) for our end to end tests.

Place your tests in `packages/tests/src/e2e/**/*.spec.ts`.

The test run takes care of building the `@datadog/*-plugin` packages locally.<br/>
You can bypass this build step prefixing your command with `CI=1 yarn [...]` reducing the duration of the run.

### Run

```bash
yarn test:e2e
```

You can use [Playwright flags](https://playwright.dev/docs/running-tests#command-line) directly after the command.

### Debug

#### From the CI

If your CI job fails, you can download the `playwright` artifact of the run, at the bottom of the summary page.

Once downloaded, extract it by double clicking on it and run the following command:

```bash
yarn playwright show-report ~/Downloads/playwright/playwright-report
```

#### Locally

Run the test with the UI enabled:

```bash
yarn test:e2e --ui
```

Then, you can use the Playwright UI to debug your test.

More information on the [Playwright documentation](https://playwright.dev/docs/running-tests#command-line).


#### Run a specific bundler or browser

There is one project for each bundler / browser combination.<br/>
The naming follows the pattern `<browser> | <bundler>` eg. `chrome | webpack4`.

You can use the `--project` flag to target a specific project (or multiple projects):

```bash
yarn test:e2e --project "chrome | webpack4" --project "firefox | esbuild"
```

It also supports glob patterns:

```bash
# Run all the bundlers for the chrome browser.
yarn test:e2e --project "chrome | *"

# Run all browsers for the webpack4 bundler.
yarn test:e2e --project "* | webpack4"
```
