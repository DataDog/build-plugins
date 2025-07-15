# Analytics Plugin <!-- #omit in toc -->

Send some analytics data to Datadog internally.

Will send a log at the beginning of a build.

```typescript
{
    ddsource: `@datadog/${bundlerName}-plugin`,
    env: 'production',
    message: 'Build started',
    service: 'build-plugins',
    bundler: {
        name: bundlerName,
        version: bundlerVersion,
    },
    metadata: buildMetadata,
    plugins: [pluginNames],
    version: pluginVersion,
    team: 'language-foundations',
    ...rest,
}
```
