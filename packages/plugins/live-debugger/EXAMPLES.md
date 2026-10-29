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
-   [Function IDs](#function-ids)
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;add');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {a, b});
        const sum = a + b;
        return ($dd_rv0 = sum, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {a, b}, {sum}) : $dd_rv0);
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {a, b}); throw $dd_e; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;double');
    try {
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {x});
        const $dd_rv0 = x * 2;
        if ($dd_p0) $dd_return($dd_p0, $dd_rv0, this, {x});
        return $dd_rv0;
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {x}); throw $dd_e; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;getObj');
    try {
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {x});
        const $dd_rv0 = {key: x};
        if ($dd_p0) $dd_return($dd_p0, $dd_rv0, this, {x});
        return $dd_rv0;
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {x}); throw $dd_e; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;getTime');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this);
        return ($dd_rv0 = Date.now(), $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this) : $dd_rv0);
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this); throw $dd_e; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;getTime');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this);
        const now = Date.now();
        return ($dd_rv0 = now, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, undefined, {now}) : $dd_rv0);
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this); throw $dd_e; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;log');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {msg});
        console.log(msg);
        if ($dd_p0) $dd_return($dd_p0, undefined, this, {msg});
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {msg}); throw $dd_e; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;earlyExit');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {x});
        if (!x) {
            if ($dd_p0) $dd_return($dd_p0, undefined, this, {x});
            return;
        }
        console.log(x);
        if ($dd_p0) $dd_return($dd_p0, undefined, this, {x});
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {x}); throw $dd_e; }
}
```

When the bare `return;` is the brace-less body of an `if`, `else`, or loop, the report and the
`return` are wrapped in braces, so the return stays conditional:

```js
// Before
if (!x) return;

// After
if (!x) { if ($dd_p0) $dd_return($dd_p0, undefined, this, {x}); return; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;abs');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {x});
        if (x < 0) {
            return ($dd_rv0 = -x, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
        }
        return ($dd_rv0 = x, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {x}); throw $dd_e; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;sign');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {x});
        if (x > 0) {
            return ($dd_rv0 = 1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
        } else {
            return ($dd_rv0 = -1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
        }
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {x}); throw $dd_e; }
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
    let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/utils.js;f');
    try {
        let $dd_rv0;
        if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {flag});
        if (flag) {
            return ($dd_rv0 = 1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {flag}) : $dd_rv0);
        }
        const later = 2;
        return ($dd_rv0 = later, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {flag}, {later}) : $dd_rv0);
    } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {flag}); throw $dd_e; }
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
            let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/Button.js;Button.constructor/handleClick');
            try {
                if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, $dd_t);
                const $dd_rv0 = this.props.onClick();
                if ($dd_p0) $dd_return($dd_p0, $dd_rv0, $dd_t);
                return $dd_rv0;
            } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, $dd_t); throw $dd_e; }
        };
        ($dd_t = super(props));
        this.handleClick = handleClick;
    }
}
```

## Arrow inside a super call argument

An arrow nested in the `super(...)` argument is instrumented with the `$dd_t` receiver, and the
surrounding `super(...)` call is wrapped to capture the receiver. This arrow is anonymous, so its
ID names it `<anonymous>` (see [Function IDs](#function-ids)).

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
            let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/widget.js;Widget.constructor/<anonymous>');
            try {
                if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, $dd_t, {x});
                const $dd_rv0 = x * 2;
                if ($dd_p0) $dd_return($dd_p0, $dd_rv0, $dd_t, {x});
                return $dd_rv0;
            } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, $dd_t, {x}); throw $dd_e; }
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
            let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/widget.js;Widget.constructor/init');
            try {
                if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, $dd_t);
                const $dd_rv0 = ($dd_t = super(args));
                if ($dd_p0) $dd_return($dd_p0, $dd_rv0, $dd_t);
                return $dd_rv0;
            } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, $dd_t); throw $dd_e; }
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
            let $dd_p0 = globalThis.$dd_probes !== void 0 && $dd_probes('src/widget.js;Widget.constructor/double');
            try {
                let $dd_rv0;
                if ($dd_p0) $dd_p0 = $dd_entry($dd_p0, this, {x});
                return ($dd_rv0 = x * 2, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);
            } catch($dd_e) { if ($dd_p0) $dd_throw($dd_p0, $dd_e, this, {x}); throw $dd_e; }
        };
        super(items.map(double));
    }
}
```

## Function IDs

A function's ID is the path of its file, relative to the git repository root, followed by `;`
and the function's qualified name. Without a git repository, the path is relative to the build
root instead.

The qualified name is the function's own name, prefixed by the qualified name of the closest
named function or class around it: `<class>.` for methods and class properties, `<function>/`
otherwise. Getters and setters end with `:get` and `:set`, and functions without a name are
`<anonymous>`. Anonymous functions and classes don't prefix the names of the functions inside
them, and neither do object literals. For example, in `src/cart.js`:

| Function | ID |
| --- | --- |
| `function add() {}` | `src/cart.js;add` |
| `total` in `class Cart { total() {} }` | `src/cart.js;Cart.total` |
| The `size` getter in `class Cart { get size() {} }` | `src/cart.js;Cart.size:get` |
| The arrow in `class Cart { handler = () => {} }` | `src/cart.js;Cart.handler` |
| The callback in `function doubleAll(xs) { return xs.map((x) => x * 2); }` | `src/cart.js;doubleAll/<anonymous>` |
| `open` in `function make() { return class Box { open() {} }; }` | `src/cart.js;make/Box.open` |

When several functions of a file have the same qualified name, such as two callbacks in the same
function, the second one gets `#1`, the third one `#2`, and so on, in source order:

```js
function load() {
    // src/cart.js;load/<anonymous>
    fetchItems().then((items) => render(items));
    // src/cart.js;load/<anonymous>#1
    fetchPrices().then((prices) => render(prices));
}
```

IDs don't depend on line numbers, so a function keeps its ID when the code around it changes. It
gets a new ID when it's renamed, when it moves to another file, function, or class, or when a
function with the same qualified name is added before it.

## What is not instrumented

Some functions are skipped regardless of the before/after patterns above:

-   **Generators** (`function*`) and **class constructors** are always skipped — see [Skipped function types](./README.md#skipped-function-types).
-   Functions marked with the `// @dd-no-instrumentation` comment when [`honorSkipComments`](./README.md#livedebuggerhonorskipcomments) is enabled.
-   Function kinds excluded via [`liveDebugger.functionTypes`](./README.md#livedebuggerfunctiontypes), and anonymous functions when [`liveDebugger.namedOnly`](./README.md#livedebuggernamedonly) is `true`.
-   Whole files are skipped before parsing when they contain no function syntax, or when they reference unsupported virtual imports (for example `?worker`, `?sprite`, `@css-module:`, or `dynamic!` specifiers).
