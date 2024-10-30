# Injection Plugin <!-- #omit in toc -->

This is used to prepend some code to the produced bundle.<br/>
Particularly useful if you want to share some global context, or to automatically inject some SDK.

It gives you access to the `context.inject()` function.

All the injections will be resolved during the `buildStart` hook,<br/>
so you'll have to have submitted your injection prior to that.<br/>
Ideally, you'd submit it during your plugin's initialization.

## Distant file

You can give it a distant file.<br/>
Be mindful that a 5s timeout is enforced.

```typescript
context.inject({
    type: 'file',
    value: 'https://example.com/my_file.js',
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
});
```

## Raw code

Or give it any kind of string.<br/>
Be mindful that the code needs to be executable, or the plugins will crash.

```typescript
context.inject({
    type: 'code',
    value: 'console.log("My un-invasive code");',
});
```
