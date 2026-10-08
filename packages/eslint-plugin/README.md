# ESLint Plugin

Private ESLint rules for this repository, loaded from `.eslintrc.js` as `@dd`.

## `@dd/no-whole-process-env`

A whole copy of `process.env` in test code carries every secret the test env scrub misses, and a failing assertion can print it.

The rule recognizes the global `process`: `process`, `global.process`, `globalThis.process`, and `Reflect.get(globalThis, 'process')`, behind `?:`, `||`, `??`, and TypeScript wrappers. A local binding named `process` shadows it; type-only imports and ambient declarations don't. It doesn't follow values through bindings: taking hold of `process` whole is reported where it happens.

It reports:

- `process.env` used other than to read names or single keys, including an alias such as `import env = process.env`. Allowed: key access, `in`, `for...in`, `Object.keys` and other keyed calls such as `Reflect.get` and `jest.replaceProperty(process.env, 'KEY', value)`, `typeof`, truthiness tests and `&&` guards, named-key destructuring (none of them reading `valueOf`, `constructor`, or `__proto__`, which hand back the env, as below), and `Object.assign`, `Object.defineProperty`, or `Object.defineProperties` writing keys onto it with the result discarded.
- `process.env` replaced or deleted: assigned, `delete`d, or redefined through `jest.replaceProperty`, `jest.spyOn`, `Object.defineProperty`, or `Object.assign(process, { env })`.
- `process` itself bound or passed whole: an alias (including `import p = globalThis.process`), a default, an assignment, a parameter property, a rest destructure, a spread, an argument, a return value (other than from a Jest hook, which discards it), an export, or the left operand of `instanceof`. Allowed: reading its keys, keyed calls such as `Object.keys(process)`, `Object.defineProperty(process, 'platform', …)` with the result discarded (it returns process), comparisons and other operators, and destructuring named keys, with `env` only into named keys of it and none of `report`, `valueOf`, `constructor`, or `__proto__`. Those last three hand back what they're read off: `valueOf` returns process or the env, `constructor` returns the global object (detached, off process) or a live view of the env (off `process.env`), and `__proto__` reaches the prototype holding that constructor. So reading any of them off process or `process.env` (a member read, a keyed read, a destructured key, a named import, or an `import =` alias) is reported, and so are the accessor helpers below.
- `process.report` used in any way, since its reports, printed or written to disk, hold the env.
- Loading the process module whole: a default or namespace import, `import =` of the module (including `export import`), `require`, `jest.requireActual`, `jest.requireMock`, `import()`, or `process.getBuiltinModule`. Named imports other than `env`, `report`, `valueOf`, `constructor`, `__proto__`, and the accessor helpers below are allowed.
- Reading the global `process` through its property descriptor, and replacing or deleting it, including spying on its getter with `jest.spyOn(globalThis, 'process', 'get')`, `Reflect.deleteProperty(globalThis, 'process')`, and a destructuring, `for...of`, or `for...in` target.
- The inherited accessor helpers (`__lookupGetter__`, `__lookupSetter__`, `__defineGetter__`, `__defineSetter__`) reached by a member read, a keyed call other than an existence check, such as `Reflect.get(Object.prototype, '__lookupGetter__')`, the bare global, a destructured key, a named import, an `import =` alias, or a re-export. They read any accessor, `process.report` and the global `process` included, and redefine any property, `process.env` included, so they're banned in test code rather than tracked; `Object.getOwnPropertyDescriptor` and `Object.defineProperty` do the same job visibly.

It applies to Jest and Playwright tests, fixture files (`*.fixture.*`, `*.fixtures.*`), helpers, and e2e fixture projects, benchmarks, and the test runner configs (see `.eslintrc.js`). `.eslintignore` keeps the sample bundler projects under `packages/tests/**/fixtures` out of all linting, this rule included.

Mark a deliberate copy with a line-level disable that says why:

```ts
// eslint-disable-next-line @dd/no-whole-process-env -- fixture setup's yarn and git steps need the full env
```

### Known limits

The rule follows syntax, so these classes of use aren't seen, and a new finding that falls in one of them is a known limit rather than a bug:

- **Non-literal keys and specifiers**: `process[name]`, `{ [name]: value } = process`, `require(name)`, `import(name)`.
- **Containers of `process`**: the global object reached other than as `global` or `globalThis` (an alias such as `const g = globalThis`, or `globalThis.globalThis`), or passed whole.
- **Values `process` returns**: the emitter methods it inherits that return it, such as `process.on(...)`.
- **Values that hold `process`**: a `jest.spyOn` mock records `process` as `this` in `mock.contexts`, and a listener registered on `process` runs with it as `this`; printing those prints the env.
- **Other loaders and evaluators, and loaders called indirectly**: `module.require`, `createRequire`, `process.mainModule.require`, `eval`, `vm`, and a loader the rule covers called other than directly, such as `require.call(null, 'process')`, `Reflect.apply(require, …)`, an alias of `require`, or a detached `getBuiltinModule`.
- **TypeScript namespaces named `process`**: whether a non-ambient one shadows the global depends on what it holds, so the rule treats any such namespace as a local binding. A `declare namespace process` is erased and still counts as the global.
- **Patched built-ins**: keyed calls are trusted by name, so a test that replaces a built-in such as `Object.keys` can make an allowed call return the env.
- **Functions and accessors a test installs**: a method, getter, setter, `toString` or `toJSON`, or prototype that a test adds to `process`, `process.env`, or a prototype either inherits from (`Object.prototype`, `EventEmitter.prototype`) runs with `process` or the env as `this` when it's called, read, or triggered by a conversion. Test code that deliberately installs functions or accessors there is out of scope; any form of it, including through `jest.spyOn` or `Object.defineProperty`, falls in this class.
- **Key-by-key copies**: `Object.keys(process.env)` mapped to `process.env[key]`.
- **Env built by code under test**: source files are out of scope, so an env that source code builds and passes to a mocked call, such as `spawn`, prints whole when a test asserts on that call.
- **Inherited env**: a child process or Worker started without an explicit `env`.

The test env scrub in `packages/tests/src/_jest` is what keeps secrets out of tests; this rule only stops the common whole-env patterns.
