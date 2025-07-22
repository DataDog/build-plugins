# Bundler Report Plugin <!-- #omit in toc -->

A very basic report on the currently used bundler.<br/>
It is useful to unify some configurations.

## Global Context

```typescript
{
    bundler: {
        name: string;
        outDir: string; // Output directory
        // Added in `buildStart`.
        rawConfig?: any;
    };
}
```

## Hooks

### `bundlerReport`

This hook is called when the bundler report is generated.<br/>
It is useful to get the current bundler's configuration for instance.
Happens during the `buildStart` hook.

```typescript
{
    name: 'my-plugin',
    bundlerReport(report: BundlerReport) {
        // Do something with the data
    }
}
```

### `cwd`

This hook is called when the current working directory is computed.<br/>
Happens during the `buildStart` hook.

```typescript
{
    name: 'my-plugin',
    cwd(cwd: string) {
        // Do something with the data
    }
}
```
