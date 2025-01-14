# Injection Plugin <!-- #omit in toc -->

This is used to inject some code to the produced bundle.<br/>
Particularly useful :
- to share some global context.
- to automatically inject some SDK.
- to initialise some global dependencies.
- ...

It gives you access to the `context.inject()` function.

All the injections will be resolved during the `buildStart` hook,<br/>
so you'll have to "submit" your injection(s) prior to that.<br/>
Ideally, you'd submit it during your plugin's initialization.

There are three positions to inject content:

- `InjectPosition.START`: Added at the very beginning of the bundle, outside any closure.
- `InjectPosition.MIDDLE`: Added at the begining of the entry file, within the context of the bundle.
- `InjectPosition.END`: Added at the very end of the bundle, outside any closure.

There are three types of injection:

## Distant file

You can give it a distant file.<br/>
Be mindful that a 5s timeout is enforced.

```typescript
context.inject({
    type: 'file',
    value: 'https://example.com/my_file.js',
    position: InjectPosition.START,
});
```

## Local file

You also give it a local file.<br/>
While you can use either a relative or absolute path, it's best to use an absolute one.<br/>
Remember that the plugins are also bundled before distribution.

```typescript
context.inject({
    type: 'file',
    value: path.resolve(__dirname, '../my_file.js'),
    position: InjectPosition.END,
});
```

## Raw code

Or give it any kind of string.<br/>
Be mindful that the code needs to be executable, or the plugins will crash.

```typescript
context.inject({
    type: 'code',
    value: 'console.log("My un-invasive code");',
    position: InjectPosition.MIDDLE,
});
```
