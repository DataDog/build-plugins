# Bundler Report Plugin <!-- #omit in toc -->

A very basic report on the currently used bundler.<br/>
It is useful to unify some configurations.

## Global Context

```typescript
{
    bundler: {
        name: string;
        outDir: string;
        rawConfig?: any;
    };
}
```

## Hooks

### `bundlerReport`

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

### `buildRoot`

This hook is called when the build root directory is computed.<br/>

```typescript
{
    name: 'my-plugin',
    buildRoot(buildRoot: string) {
        // Do something with the data
    }
}
```
