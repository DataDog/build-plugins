# Telemetry Plugin Tests

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
