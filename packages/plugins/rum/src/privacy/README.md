# RUM Privacy Plugin <!-- #omit in toc -->

The RUM Privacy Plugin provides action name and session replay masking capabilities for Real User Monitoring (RUM). This plugin helps protect sensitive data while maintaining observability.

## Use Cases

This plugin is particularly useful for:
- Masking sensitive data before sending telemetry to Datadog
- Providing an out-of-the-box solution with minimal instrumentation overhead 
- Maintaining observability while ensuring privacy compliance

## Reserved Global Variables

The following global variable is used by this plugin:
- `$DD_ALLOW` - Contains raw static strings from source code

## File Inclusion/Exclusion for String Literal Extraction

### Default Settings

By default, the plugin excludes:
- `node_modules` directories
- `.preval` files
- Files that start with special characters

### Custom Configuration

You can customize file inclusion/exclusion using regular expressions:

```javascript
exclude: [/app\/packages\/mocks/]
```

## Global Function Name Configuration

The plugin injects a global function to extract static strings from source code dynamically. By default, this function is named `$`.

To avoid naming conflicts with existing code, you can override this function name using the `addToDictionaryFunctionName` configuration option.

**Example:**
```javascript
addToDictionaryFunctionName: 'myCustomFunction'
```
