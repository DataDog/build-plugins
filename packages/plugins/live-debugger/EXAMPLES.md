# Live Debugger Transformation Examples <!-- #omit in toc -->

This page catalogs the before/after output of the Live Debugger transform for a range of
function shapes and edge cases. For an overview of how the instrumentation works, see the
plugin's [How it works](./README.md#how-it-works) section.

A few conventions used throughout:

-   The injected globals (`$dd_probes`, `$dd_entry`, `$dd_return`, `$dd_throw`) are provided by the Browser Debugger SDK at runtime — see [Runtime requirements](./README.md#runtime-requirements).
-   The per-function locals carry a numeric suffix (`$dd_p0`, `$dd_rv0`); the index increments for each instrumented function in a file.
-   The captured-arguments object literal (e.g. `{a, b}`) is inlined directly at each probe-guarded call site and is only emitted when the function has parameters. It is built lazily — inside the `if (probe)` / `probe ? ` guards — so dormant calls allocate nothing.
-   Indentation below is reformatted for readability; the real output preserves the original source layout.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Block-body function](#block-body-function)
-   [Arrow function with expression body](#arrow-function-with-expression-body)
-   [Arrow returning an object literal](#arrow-returning-an-object-literal)
-   [Function with no parameters](#function-with-no-parameters)
-   [Function with no parameters but local variables](#function-with-no-parameters-but-local-variables)
-   [Function with no return value](#function-with-no-return-value)
-   [Bare return and early exit](#bare-return-and-early-exit)
-   [Multiple returns](#multiple-returns)
-   [Exhaustive if and else returns](#exhaustive-if-and-else-returns)
-   [Returns before a local declaration](#returns-before-a-local-declaration)
-   [Functions inside a derived class constructor](#functions-inside-a-derived-class-constructor)
-   [Arrow inside a super call argument](#arrow-inside-a-super-call-argument)
-   [Arrow whose body is a super call](#arrow-whose-body-is-a-super-call)
-   [Function expressions keep their own this](#function-expressions-keep-their-own-this)
-   [Anonymous function IDs](#anonymous-function-ids)
-   [What is not instrumented](#what-is-not-instrumented)
<!-- #toc -->

## Block-body function

The most common shape: parameters, a local variable, and an explicit `return`. The return is
rewritten so the original value is captured (`$dd_rv0`) and reported only when a probe is active.
In-scope locals (here, `sum`) are captured in the final argument to `$dd_return`.

```js
// Before
function add(a, b) {
    const sum = a + b;
    return sum;
}

// After
function add(a, b) {
    const $dd_p0 = $dd_probes('src/utils.js;add');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_entry($dd_p0, this, {a, b});
        const sum = a + b;
        return ($dd_rv0 = sum, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {a, b}, {sum}) : $dd_rv0);
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {a, b}); throw e; }
}
```

## Arrow function with expression body

An arrow with an expression body is rewritten into a block body. The original expression is
assigned to `$dd_rv0` so it can be reported and then returned.

```js
// Before
const double = (x) => x * 2;

// After
const double = (x) => {
    const $dd_p0 = $dd_probes('src/utils.js;double');
    try {
        if ($dd_p0) $dd_entry($dd_p0, this, {x});
        const $dd_rv0 = x * 2;
        if ($dd_p0) $dd_return($dd_p0, $dd_rv0, this, {x});
        return $dd_rv0;
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }
};
```

## Arrow returning an object literal

When the expression body is a parenthesized object literal, the wrapping parentheses are
removed as the body becomes a block.

```js
// Before
const getObj = (x) => ({key: x});

// After
const getObj = (x) => {
    const $dd_p0 = $dd_probes('src/utils.js;getObj');
    try {
        if ($dd_p0) $dd_entry($dd_p0, this, {x});
        const $dd_rv0 = {key: x};
        if ($dd_p0) $dd_return($dd_p0, $dd_rv0, this, {x});
        return $dd_rv0;
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }
};
```

## Function with no parameters

With no parameters, no arguments object is generated and the receiver (`this`) is passed without
one.

```js
// Before
function getTime() {
    return Date.now();
}

// After
function getTime() {
    const $dd_p0 = $dd_probes('src/utils.js;getTime');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_entry($dd_p0, this);
        return ($dd_rv0 = Date.now(), $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this) : $dd_rv0);
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this); throw e; }
}
```

## Function with no parameters but local variables

When there are no parameters but there are locals to capture, the arguments slot is filled with
`undefined` so the captured locals (`{now}`) line up as the trailing argument.

```js
// Before
function getTime() {
    const now = Date.now();
    return now;
}

// After
function getTime() {
    const $dd_p0 = $dd_probes('src/utils.js;getTime');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_entry($dd_p0, this);
        const now = Date.now();
        return ($dd_rv0 = now, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, undefined, {now}) : $dd_rv0);
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this); throw e; }
}
```

## Function with no return value

A function that never returns a value still reports its exit: a trailing
`$dd_return(..., undefined, ...)` is injected before the closing brace.

```js
// Before
function log(msg) {
    console.log(msg);
}

// After
function log(msg) {
    const $dd_p0 = $dd_probes('src/utils.js;log');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_entry($dd_p0, this, {msg});
        console.log(msg);
        if ($dd_p0) $dd_return($dd_p0, undefined, this, {msg});
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {msg}); throw e; }
}
```

## Bare return and early exit

A bare `return;` (no argument) is preceded by an explicit `$dd_return(..., undefined, ...)`. A
trailing report is also added for the implicit fall-through exit.

```js
// Before
function earlyExit(x) {
    if (!x) {
        return;
    }
    console.log(x);
}

// After
function earlyExit(x) {
    const $dd_p0 = $dd_probes('src/utils.js;earlyExit');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_entry($dd_p0, this, {x});
        if (!x) {
            if ($dd_p0) $dd_return($dd_p0, undefined, this, {x});
            return;
        }
        console.log(x);
        if ($dd_p0) $dd_return($dd_p0, undefined, this, {x});
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }
}
```

## Multiple returns

Every `return` statement is wrapped independently.

```js
// Before
function abs(x) {
    if (x < 0) {
        return -x;
    }
    return x;
}

// After
function abs(x) {
    const $dd_p0 = $dd_probes('src/utils.js;abs');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_entry($dd_p0, this, {x});
        if (x < 0) {
            return ($dd_rv0 = -x, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
        }
        return ($dd_rv0 = x, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }
}
```

## Exhaustive if and else returns

When control-flow analysis proves every path returns, no trailing `$dd_return` is appended.

```js
// Before
function sign(x) {
    if (x > 0) {
        return 1;
    } else {
        return -1;
    }
}

// After
function sign(x) {
    const $dd_p0 = $dd_probes('src/utils.js;sign');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_entry($dd_p0, this, {x});
        if (x > 0) {
            return ($dd_rv0 = 1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
        } else {
            return ($dd_rv0 = -1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
        }
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }
}
```

## Returns before a local declaration

Local capture respects scope: only variables that are already declared (and not in their
temporal dead zone) at the exit point are captured. The early `return 1` captures nothing,
while the later `return later` captures `{later}`.

```js
// Before
function f(flag) {
    if (flag) {
        return 1;
    }
    const later = 2;
    return later;
}

// After
function f(flag) {
    const $dd_p0 = $dd_probes('src/utils.js;f');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_entry($dd_p0, this, {flag});
        if (flag) {
            return ($dd_rv0 = 1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {flag}) : $dd_rv0);
        }
        const later = 2;
        return ($dd_rv0 = later, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {flag}, {later}) : $dd_rv0);
    } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {flag}); throw e; }
}
```

## Functions inside a derived class constructor

In a derived constructor (a class that `extends` another), `this` is not available until
`super()` has run. For functions defined in that scope, the plugin cannot reference `this`
directly for the receiver. Instead it declares a `$dd_t` alias at the top of the constructor,
captures the receiver by wrapping the `super(...)` call as `($dd_t = super(...))`, and uses
`$dd_t` instead of `this` in the instrumentation.

The constructor itself is never instrumented (see [What is not instrumented](#what-is-not-instrumented)),
and the user's own `this.props` inside the function body is left untouched — only the receiver
passed to the instrumentation helpers uses the `$dd_t` alias.

```js
// Before
class Button extends Component {
    constructor(props) {
        const handleClick = () => this.props.onClick();
        super(props);
        this.handleClick = handleClick;
    }
}

// After
class Button extends Component {
    constructor(props) {
        let $dd_t;
        const handleClick = () => {
            const $dd_p0 = $dd_probes('src/Button.js;handleClick');
            try {
                if ($dd_p0) $dd_entry($dd_p0, $dd_t);
                const $dd_rv0 = this.props.onClick();
                if ($dd_p0) $dd_return($dd_p0, $dd_rv0, $dd_t);
                return $dd_rv0;
            } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, $dd_t); throw e; }
        };
        ($dd_t = super(props));
        this.handleClick = handleClick;
    }
}
```

## Arrow inside a super call argument

An arrow nested in the `super(...)` argument is instrumented with the `$dd_t` receiver, and the
surrounding `super(...)` call is wrapped to capture the receiver. This arrow is anonymous, so its
ID uses the `<anonymous>@<line>:<column>:<index>` form (see [Anonymous function IDs](#anonymous-function-ids));
the exact numbers depend on the original source position.

```js
// Before
class Widget extends Base {
    constructor(items) {
        super(items.map((x) => x * 2));
    }
}

// After
class Widget extends Base {
    constructor(items) {
        let $dd_t;
        ($dd_t = super(items.map((x) => {
            const $dd_p0 = $dd_probes('src/widget.js;<anonymous>@4:16:0');
            try {
                if ($dd_p0) $dd_entry($dd_p0, $dd_t, {x});
                const $dd_rv0 = x * 2;
                if ($dd_p0) $dd_return($dd_p0, $dd_rv0, $dd_t, {x});
                return $dd_rv0;
            } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, $dd_t, {x}); throw e; }
        })));
    }
}
```

## Arrow whose body is a super call

When the arrow's own expression body is the `super(...)` call, the receiver capture is folded
into the return-value assignment: `const $dd_rv0 = ($dd_t = super(args));`.

```js
// Before
class Widget extends Base {
    constructor(args) {
        const init = () => super(args);
        init();
    }
}

// After
class Widget extends Base {
    constructor(args) {
        let $dd_t;
        const init = () => {
            const $dd_p0 = $dd_probes('src/widget.js;init');
            try {
                if ($dd_p0) $dd_entry($dd_p0, $dd_t);
                const $dd_rv0 = ($dd_t = super(args));
                if ($dd_p0) $dd_return($dd_p0, $dd_rv0, $dd_t);
                return $dd_rv0;
            } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, $dd_t); throw e; }
        };
        init();
    }
}
```

## Function expressions keep their own this

Unlike arrows, a non-arrow `function` expression has its own `this` binding, so even inside a
derived constructor it is instrumented with `this` (no `$dd_t` alias, and the constructor's
`super(...)` is left untouched).

```js
// Before
class Widget extends Base {
    constructor(items) {
        const double = function(x) { return x * 2; };
        super(items.map(double));
    }
}

// After
class Widget extends Base {
    constructor(items) {
        const double = function(x) {
            const $dd_p0 = $dd_probes('src/widget.js;double');
            try {
                let $dd_rv0;
                if ($dd_p0) $dd_entry($dd_p0, this, {x});
                return ($dd_rv0 = x * 2, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
            } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }
        };
        super(items.map(double));
    }
}
```

## Anonymous function IDs

Named functions get the ID `<file-path>;<function-name>`. Anonymous functions — including
callbacks that are not assigned to a variable, property, or method — instead use:

```
<file-path>;<anonymous>@<line>:<column>:<sibling-index>
```

where `<line>` and `<column>` are the function's position in the original source and
`<sibling-index>` disambiguates multiple anonymous functions that share the same parent node.
For example, the callback in `[1, 2].map((x) => x * 2)` might become:

```js
const $dd_p0 = $dd_probes('src/utils.js;<anonymous>@1:11:0');
```

> Setting [`liveDebugger.namedOnly`](./README.md#livedebuggernamedonly) to `true` skips
> anonymous callbacks entirely, so only the `<file-path>;<function-name>` form is produced.

## What is not instrumented

Some functions are skipped regardless of the before/after patterns above:

-   **Generators** (`function*`) and **class constructors** are always skipped — see [Skipped function types](./README.md#skipped-function-types).
-   Functions marked with the `// @dd-no-instrumentation` comment when [`honorSkipComments`](./README.md#livedebuggerhonorskipcomments) is enabled.
-   Function kinds excluded via [`liveDebugger.functionTypes`](./README.md#livedebuggerfunctiontypes), and anonymous functions when [`liveDebugger.namedOnly`](./README.md#livedebuggernamedonly) is `true`.
-   Whole files are skipped before parsing when they contain no function syntax, or when they reference unsupported virtual imports (for example `?worker`, `?sprite`, `@css-module:`, or `dynamic!` specifiers).
