# Async Queue Plugin <!-- #omit in toc -->

An internal queue for async actions that we want to finish before quitting the build.


## Usage

Use the `BuildReport.queue: []` to add async actions to the queue.

```typescript
const promise = asyncAction(); // some async action that returns a promise
build.queue(promise);
```

The queue will wait for all actions to finish before quitting the build.
