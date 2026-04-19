# Live Debugger Plugin <!-- #omit in toc -->

Automatically instrument JavaScript functions at build time to enable Live Debugger without requiring code rebuilds.

<!-- The title and the following line will both be added to the root README.md  -->

## Table of content <!-- #omit in toc -->

<!-- This is auto generated with yarn cli integrity -->

<!-- #toc -->
-   [Required peer dependencies](#required-peer-dependencies)
-   [Configuration](#configuration)
-   [How it works](#how-it-works)
    -   [liveDebugger.enable](#livedebuggerenable)
    -   [liveDebugger.version](#livedebuggerversion)
    -   [liveDebugger.include](#livedebuggerinclude)
    -   [liveDebugger.exclude](#livedebuggerexclude)
    -   [liveDebugger.honorSkipComments](#livedebuggerhonorskipcomments)
    -   [liveDebugger.functionTypes](#livedebuggerfunctiontypes)
    -   [liveDebugger.namedOnly](#livedebuggernamedonly)
-   [Skipped function types](#skipped-function-types)
-   [Runtime requirements](#runtime-requirements)
    -   [Safe fallback when the SDK is absent](#safe-fallback-when-the-sdk-is-absent)
    -   [Activating probes](#activating-probes)
<!-- #toc -->

## Required peer dependencies

The Live Debugger transform relies on Babel and `magic-string`. To keep the cost of
`@datadog/*-plugin` packages small for projects that don't use Live Debugger, these
are declared as **optional peer dependencies**. When you enable the plugin by
providing a `liveDebugger` configuration, install them in your project:

```bash
# npm
npm install --save-dev @babel/parser @babel/traverse @babel/types magic-string

# yarn
yarn add --dev @babel/parser @babel/traverse @babel/types magic-string

# pnpm
pnpm add --save-dev @babel/parser @babel/traverse @babel/types magic-string
```

If any of these packages is missing when the plugin tries to instrument a file,
the plugin throws an error with the exact install command above.

## Configuration

```ts
liveDebugger?: {
    enable?: boolean;
    version?: string;
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
    honorSkipComments?: boolean;
    functionTypes?: FunctionKind[];
    namedOnly?: boolean;
}
```

## How it works

The Live Debugger plugin automatically instruments all JavaScript functions in your application at build time. It adds lightweight checks that can be activated at runtime without rebuilding your code.

Each instrumented function gets:
- A unique, stable function ID (format: `<file-path>;<function-name>`)
- A `$dd_probes()` call that returns active probes for that function (or `undefined` if none)
- Deferred variable-capture helpers (`$dd_e<N>` for entry variables, `$dd_l<N>` for exit variables) that are only evaluated when probes are active
- Entry point tracking with parameter capture via `$dd_entry()`
- Return value tracking with local variable capture via `$dd_return()`
- Exception tracking with variable state at throw time via `$dd_throw()`

The instrumentation checks whether probes are active by calling `$dd_probes(functionId)`. When no probes are active, the function returns `undefined` and all instrumentation is skipped — only the `$dd_probes` call and a conditional check remain on the hot path.

When `liveDebugger.version` is set, it should match the immutable deployed build identifier used by your Browser Debugger SDK initialization. If you also upload sourcemaps through the Error Tracking plugin, use the same value for `errorTracking.sourcemaps.releaseVersion`.

**Example transformation (block body):**

```javascript
// Before
function add(a, b) {
    const sum = a + b;
    return sum;
}

// After
function add(a, b) {
    const $dd_p = $dd_probes('src/utils.js;add');
    const $dd_e = () => ({a, b});
    try {
        const $dd_l = () => ({a, b, sum});
        let $dd_rv;
        if ($dd_p) $dd_entry($dd_p, this, $dd_e());
        const sum = a + b;
        return ($dd_rv = sum, $dd_p ? $dd_return($dd_p, $dd_rv, this, $dd_e(), $dd_l()) : $dd_rv);
    } catch(e) { if ($dd_p) $dd_throw($dd_p, e, this, $dd_e()); throw e; }
}
```

When entry and exit variables are the same (i.e. the function has no local variable declarations), only a single helper is emitted and shared for both positions.

**Example transformation (arrow expression body):**

```javascript
// Before
const double = (x) => x * 2;

// After
const double = (x) => {
    const $dd_p = $dd_probes('src/utils.js;double');
    const $dd_e = () => ({x});
    try {
        if ($dd_p) $dd_entry($dd_p, this, $dd_e());
        const $dd_rv = x * 2;
        if ($dd_p) $dd_return($dd_p, $dd_rv, this, $dd_e(), $dd_e());
        return $dd_rv;
    } catch(e) { if ($dd_p) $dd_throw($dd_p, e, this, $dd_e()); throw e; }
};
```

### liveDebugger.enable

> default: `true` when a `liveDebugger` config block is present, `false` otherwise.

Enable or disable the plugin without removing its configuration. Must be a boolean.

### liveDebugger.version

Optional. When set, use an immutable deployed browser build identifier. This value should match:

- the `version` passed to `@datadog/browser-debugger`
- `errorTracking.sourcemaps.releaseVersion` when sourcemap upload is enabled

If omitted, Live Debugger instrumentation still works, but browser build lookup and source-code-aware resolution will gracefully degrade.

### liveDebugger.include

> default: `[/\.[jt]sx?$/]`

Array of file patterns (strings or RegExp) to include for instrumentation. By default, all JavaScript and TypeScript files (`.js`, `.jsx`, `.ts`, `.tsx`) are included.

### liveDebugger.exclude

> default: `[/\/node_modules\//, /\.min\.js$/, /\/pyodide-lib\//, /^vite\//, /\0/, /commonjsHelpers\.js$/, /__vite-browser-external/, /@datadog\/browser-/, /browser-sdk\/packages\//]`

Array of file patterns (strings or RegExp) to exclude from instrumentation. By default, the following are excluded:
- `node_modules` — Third-party dependencies
- Minified files (`.min.js`)
- Bundled third-party Pyodide library (`pyodide-lib/`)
- Vite internal modules (e.g., `vite/modulepreload-polyfill`)
- Virtual modules (Rollup/Vite convention using null byte prefix)
- Rollup commonjs helpers
- Vite browser externals
- Datadog browser SDK packages (`@datadog/browser-*`, when npm linked)
- Datadog browser SDK source files (`browser-sdk/packages/`)

### liveDebugger.honorSkipComments

> default: `true`

Skip instrumentation of functions marked with the `// @dd-no-instrumentation` comment. This is useful for performance-critical functions where even the no-op overhead should be avoided.

**Example:**

```javascript
// @dd-no-instrumentation
function hotPath() {
    // This function will not be instrumented
}
```

### liveDebugger.functionTypes

> default: `undefined` (all function types)

Array of function kinds to instrument. When unset, all function types are instrumented. Valid values:

- `'functionDeclaration'` — `function foo() {}`
- `'functionExpression'` — `const foo = function() {}`
- `'arrowFunction'` — `const foo = () => {}`
- `'objectMethod'` — `{ foo() {} }`
- `'classMethod'` — `class Foo { foo() {} }`
- `'classPrivateMethod'` — `class Foo { #foo() {} }`

**Example — instrument only function declarations and arrow functions:**

```ts
liveDebugger: {
    functionTypes: ['functionDeclaration', 'arrowFunction'],
}
```

### liveDebugger.namedOnly

> default: `false`

When `true`, only named functions are instrumented. Anonymous callbacks (e.g. `[].map((x) => x)`) are skipped. A function is considered "named" if it has an explicit name via declaration, variable assignment, object/class property, or assignment target.

**Example:**

```ts
liveDebugger: {
    namedOnly: true,
}
```

With `namedOnly: true`:
- `const double = (x) => x * 2` — **instrumented** (named via variable assignment)
- `[1, 2].map((x) => x * 2)` — **skipped** (anonymous callback)
- `function add(a, b) { return a + b; }` — **instrumented** (named declaration)

## Skipped function types

The following function types are always skipped regardless of configuration:
- **Generators** — `function*` declarations and expressions
- **Constructors** — `constructor()` methods in classes

## Runtime requirements

The instrumented code calls four global functions at runtime: `$dd_probes`, `$dd_entry`, `$dd_return`, and `$dd_throw`. These are provided by the **Datadog Browser Debugger SDK** (`@datadog/browser-debugger`).

### Safe fallback when the SDK is absent

The plugin automatically injects a minimal no-op stub into every output chunk:

```javascript
if (typeof globalThis.$dd_probes === 'undefined') { globalThis.$dd_probes = function() {} }
```

This ensures that instrumented code never crashes, even if the SDK has not been loaded. The stub makes `$dd_probes` return `undefined`, which causes all `$dd_entry`, `$dd_return`, and `$dd_throw` calls to be skipped (they are guarded by `if (probe)` checks).

### Activating probes

When the Debugger SDK loads and `DD_DEBUGGER.init()` is called, it overwrites `$dd_probes` with the real implementation and sets up `$dd_entry`, `$dd_return`, and `$dd_throw`. Probes begin working immediately on the next function invocation — no rebuild required. The ordering of SDK initialization vs. application code execution does not matter.
