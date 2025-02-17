# Bundler Report Plugin <!-- #omit in toc -->

A very basic report on the currently used bundler.<br/>
It is useful to unify some configurations.

## Global Context

```typescript
{
    bundler: {
        name: string;
        fullName: string; // Including its variant.
        outDir: string; // Output directory
        // Added in `buildStart`.
        rawConfig?: any;
        variant: string; // Major version of the bundler (webpack 4, webpack 5)
    };
}
```

## Hooks

### `bundlerReport`

```typescript
{
    name: 'my-plugin',
    bundlerReport(report) {
        // Do something with the data
    }
}
```

### `cwd`

```typescript
{
    name: 'my-plugin',
    cwd(cwd) {
        // Do something with the data
    }
}
```
