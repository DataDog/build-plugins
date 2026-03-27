# RUM Privacy Plugin <!-- #omit in toc -->

The RUM Privacy Plugin provides action name and session replay masking capabilities for Real User Monitoring (RUM). This plugin helps protect sensitive data while maintaining observability.

## Use Cases

This plugin is particularly useful for:
- Masking sensitive data **before** sending them to Datadog
- Providing an out-of-the-box solution with minimal instrumentation overhead 
- Maintaining observability while ensuring privacy compliance

## Reserved Global Variables

The following global variable is used by this plugin:
- `$DD_ALLOW` - Contains raw static strings from source code
- `$DD_A_Q` - Manage the queue of adding to allowlist at runtime

## File Inclusion/Exclusion for String Literal Extraction

### Default Settings

Excludes:
- `node_modules` directories
- `.preval` files
- Files that start with special characters
Includes:
- files matching `/\.(?:c|m)?(?:j|t)sx?$/` 

### Overrides
You can override file inclusion/exclusion using regular expressions:

```javascript
exclude: [/packages\/apps\/mocks/]
include: [/packages\/apps\/.*\.(?:c|m)?(?:j|t)sx?$/],
```

> Note: if you are overriding the default setting, please make sure that you are aligned with the default setting.

### Excluding Code Blocks with Comments
#### Single Line

```javascript
  "exclude line 1", // datadog-privacy-allowlist-exclude-line
  "exclude line 2", /* datadog-privacy-allowlist-exclude-line */

  /* datadog-privacy-allowlist-exclude-line */ "exclude line 3",

  /*
   datadog-privacy-allowlist-exclude-line
   */ "exclude line 4",
```

#### Next Line
```javascript
  // datadog-privacy-allowlist-exclude-next-line
  "exclude next line 1",

  /* datadog-privacy-allowlist-exclude-next-line */
  "exclude next line 2",

  /*
   datadog-privacy-allowlist-exclude-next-line
   */
  `exclude next line 3`,
```

#### Multi-line/Blocks
```javascript
  // datadog-privacy-allowlist-exclude-begin
  "exclude range 1",
  'exclude range 2',
  `exclude range 3`,
  // datadog-privacy-allowlist-exclude-end

  /* datadog-privacy-allowlist-exclude-begin */
  "exclude range with block comment 1",
  'exclude range with block comment 2',
  `exclude range with block comment 3`,
  /* datadog-privacy-allowlist-exclude-end */


  // An unterminated 'exclude-begin' should cover the rest of the file. (And extra
  // 'exclude-begins' after that point should be ignored.)
  /* datadog-privacy-allowlist-exclude-begin */
  "exclude range with unterminated comment 1",
  'exclude range with unterminated comment 2',
  /* datadog-privacy-allowlist-exclude-begin */
  `exclude range with unterminated comment 3`,
```