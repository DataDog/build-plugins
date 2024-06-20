# Datadog Build Plugins Core

A set of core functionalities to use within the Datadog Build Plugins.

## Plugins

### Global Context

Offers to share a global context between all the plugins.

```typescript
type GlobalContext = {
    cwd: string;
    version: string;
    bundler: {
        name: string;
        config?: any;
    };
};
```
