# Live Debugger Plugin <!-- #omit in toc -->

Automatically instrument JavaScript functions at build time to enable Live Debugger without requiring code rebuilds.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Configuration](#configuration)
-   [How it works](#how-it-works)
    -   [liveDebugger.enable](#livedebuggerenable)
    -   [liveDebugger.include](#livedebuggerinclude)
    -   [liveDebugger.exclude](#livedebuggerexclude)
    -   [liveDebugger.skipHotFunctions](#livedebuggerskiphotfunctions)
<!-- #toc -->

## Configuration

```ts
liveDebugger?: {
    enable?: boolean;
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
    skipHotFunctions?: boolean;
}
```

## How it works

The Live Debugger plugin automatically instruments all JavaScript functions in your application at build time. It adds lightweight checks that can be activated at runtime without rebuilding your code.

Each instrumented function gets:
- A unique, stable function ID (format: `<file-path>;<function-name>`)
- A `$dd_probes()` call that returns active probes for that function (or `undefined` if none)
- Entry point tracking with parameter capture via `$dd_entry()`
- Return value tracking with local variable capture via `$dd_return()`
- Exception tracking with variable state at throw time via `$dd_throw()`

The instrumentation checks whether probes are active by calling `$dd_probes(functionId)`. When no probes are active, the function returns `undefined` and all instrumentation is skipped. This approach reduces bundle size by eliminating the need for individual global variables per function.

**Example transformation:**

```javascript
// Before
function add(a, b) {
    const sum = a + b;
    return sum;
}

// After
function add(a, b) {
    const $dd_p = $dd_probes('src/utils.js;add');
    try {
        if ($dd_p) $dd_entry($dd_p, this, { a, b });
        const sum = a + b;
        return $dd_p ? $dd_return($dd_p, sum, this, { a, b }, { sum }) : sum;
    } catch (e) {
        if ($dd_p) $dd_throw($dd_p, e, this, { a, b });
        throw e;
    }
}
```

### liveDebugger.enable

> default: `false`

Enable or disable Live Debugger. When enabled, all matching JavaScript files will be instrumented at build time.

### liveDebugger.include

> default: `[/\.[jt]sx?$/]`

Array of file patterns (strings or RegExp) to include for instrumentation. By default, all JavaScript and TypeScript files (`.js`, `.jsx`, `.ts`, `.tsx`) are included.

### liveDebugger.exclude

> default: `[/\/node_modules\//, /\.min\.js$/, /^vite\//, /\0/, /commonjsHelpers\.js$/, /__vite-browser-external/]`

Array of file patterns (strings or RegExp) to exclude from instrumentation. By default, the following are excluded:
- `node_modules` - Third-party dependencies
- Minified files (`.min.js`)
- Vite internal modules (e.g., `vite/modulepreload-polyfill`)
- Virtual modules (Rollup/Vite convention using null byte prefix)
- Rollup commonjs helpers
- Vite browser externals

### liveDebugger.skipHotFunctions

> default: `true`

Skip instrumentation of functions marked with the `// @dd-no-instrumentation` comment. This is useful for performance-critical functions where even the no-op overhead should be avoided.

**Example:**

```javascript
// @dd-no-instrumentation
function hotPath() {
    // This function will not be instrumented
}
```

> [!NOTE]
> Live Debugger requires the RUM SDK to be loaded for the runtime helper functions (`$dd_probes`, `$dd_entry`, `$dd_return`, `$dd_throw`). These are automatically injected when both `liveDebugger.enable` and RUM are configured.
