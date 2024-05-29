# Tests

All the workspaces are tested in this workspace.<br/>
It helps us have a better control over the test specific dependencies, and more importantly, centralize the mockings.<br/>
Especially useful for having mock projects, built with specific bundlers and run the real thing.<br/>
Right now we have mock projects for:

-   [ESBuild](./src/mocks/projects/esbuild)
-   [Webpack 4](./src/mocks/projects/webpack4)
-   [Webpack 5](./src/mocks/projects/webpack5)

## Use a mock project

You should build the project part of your test suite.

```js
beforeAll(async () => {
    const output = await exec(`yarn workspace project-{{bundler}} build`);

    // Setup what you need.
}, 20000);
```

## Build everything & Run

```bash
yarn test
```

## Only build tests

```bash
yarn build:tests
```

## Only Run

```bash
yarn workspace @dd/tests test
```
