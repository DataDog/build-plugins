// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Test runs start with CI secrets in their env, so a whole-env copy can carry any the setup scrub
// misses into failure output.
const MESSAGE =
    "Don't use process.env as a whole value in tests (reassign, replace, alias, spread, pass, or assert on it, or pass, return, or copy process itself). Read, set, or delete single keys, check for one with `'KEY' in process.env`, list names with Object.keys(process.env), reset Datadog keys with clearDatadogEnv() (packages/tests/src/_jest/helpers/datadogEnv.ts), and give child processes an env built from only the keys they need.";
const ACCESSOR_HELPER_MESSAGE =
    "Don't use the inherited __lookupGetter__, __lookupSetter__, __defineGetter__, or __defineSetter__ helpers in tests: they can read process.report and the global process, and redefine process.env. Use Object.getOwnPropertyDescriptor or Object.defineProperty on the object you mean instead.";

const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['global', 'globalThis']);
// Keys of process whose value holds or produces the whole env.
const ENV_HOLDING_KEYS = new Set(['env', 'report']);
const TYPE_WRAPPERS = new Set([
    'ChainExpression',
    'TSAsExpression',
    'TSNonNullExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
]);
// Calls that, given process or process.env first, only read names or touch the keys they're given.
const KEYED_CALLS = new Set([
    'Object.keys',
    'Object.getOwnPropertyNames',
    'Object.getOwnPropertyDescriptor',
    'Object.hasOwn',
    'Reflect.ownKeys',
    'Reflect.has',
    'Reflect.get',
    'Reflect.set',
    'Reflect.deleteProperty',
    'Reflect.defineProperty',
    'Reflect.getOwnPropertyDescriptor',
    'jest.replaceProperty',
    'jest.spyOn',
]);
// Like KEYED_CALLS, but they return their first argument, so only a discarded result is safe.
const TARGET_RETURNING_CALLS = new Set([
    'Object.assign',
    'Object.defineProperty',
    'Object.defineProperties',
]);
// Calls that only check for a key when given (process, 'key').
const EXISTENCE_CHECKS = new Set(['Object.hasOwn', 'Reflect.has']);
// Calls that copy properties onto their first argument from the other arguments.
const PROPERTY_REPLACERS = new Set(['Object.assign', 'Object.defineProperties']);
const REQUIRE_CALLS = new Set(['require', 'jest.requireActual', 'jest.requireMock']);
// Jest ignores what these return from a callback without a `done` parameter. Tests and `done`
// callbacks print a returned value in their failure message.
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
const FUNCTION_TYPES = new Set([
    'ArrowFunctionExpression',
    'FunctionDeclaration',
    'FunctionExpression',
]);
// Positions that only test a value's truthiness.
const TEST_POSITIONS = new Set([
    'IfStatement',
    'WhileStatement',
    'DoWhileStatement',
    'ConditionalExpression',
]);
// Calls that replace or delete a named property when given (target, 'name', ...).
const KEYED_REPLACERS = new Set([
    'jest.replaceProperty',
    'jest.spyOn',
    'Object.defineProperty',
    'Reflect.defineProperty',
    'Reflect.deleteProperty',
    'Reflect.set',
]);
// Keys that hand back what they're read off, or reach it: `valueOf` returns process or the env,
// `constructor` returns the global object (detached, off process) or a live view of the env (off
// process.env), and `__proto__` reaches the prototype that holds that constructor. Reading one is
// reported wherever it happens rather than tracking later calls. The emitter methods that return
// process are a documented known limit.
const HAND_BACK_KEYS = new Set(['__proto__', 'constructor', 'valueOf']);
// Whether reading `keyName` off process (`isOffEnv` false) or process.env can reach the whole env.
const isLeakingKey = (keyName, isOffEnv) =>
    HAND_BACK_KEYS.has(keyName) || (!isOffEnv && ENV_HOLDING_KEYS.has(keyName));
const isKeyedCallName = (calleeName) =>
    KEYED_CALLS.has(calleeName) || TARGET_RETURNING_CALLS.has(calleeName);
// Parents that make an identifier part of a type, as in `typeof x` or `typeof x.y`.
const TYPE_REFERENCE_PARENTS = new Set(['TSTypeQuery', 'TSQualifiedName']);
const DESCRIPTOR_READERS = new Set([
    'Object.getOwnPropertyDescriptor',
    'Reflect.getOwnPropertyDescriptor',
]);
// Inherited Object.prototype helpers that read any accessor, report and the global process
// included, or redefine any property, env included.
const ACCESSOR_HELPERS = new Set([
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
]);

// Strips wrappers that leave the runtime value unchanged, such as `as T`, `!`, `?.`, and `(0, x)`.
const unwrap = (node) => {
    let current = node;
    while (current) {
        if (TYPE_WRAPPERS.has(current.type)) {
            current = current.expression;
        } else if (current.type === 'SequenceExpression') {
            current = current.expressions[current.expressions.length - 1];
        } else {
            return current;
        }
    }
    return current;
};

const getStaticString = (node) => {
    const target = unwrap(node);
    if (target?.type === 'Literal' && typeof target.value === 'string') {
        return target.value;
    }
    if (target?.type === 'TemplateLiteral' && target.expressions.length === 0) {
        return target.quasis[0].value.cooked;
    }
    return undefined;
};

const getKeyName = (node, key) => {
    if (!node.computed && key.type === 'Identifier') {
        return key.name;
    }
    return getStaticString(key);
};

const getModuleExportName = (nameNode) =>
    nameNode.type === 'Identifier' ? nameNode.name : nameNode.value;

const getImportedName = (specifier) => getModuleExportName(specifier.imported);

const isProcessModule = (node) => {
    const specifier = getStaticString(node);
    return PROCESS_MODULES.has(specifier);
};

const findVariable = (scope, name) => {
    for (let current = scope; current; current = current.upper) {
        const variable = current.set.get(name);
        if (variable) {
            return variable;
        }
    }
    return undefined;
};

// A `declare`d class, function, enum, namespace, or variable, or anything inside a `declare`
// block, is erased at runtime.
const isAmbient = (node) => {
    for (let current = node; current; current = current.parent) {
        if (current.declare === true) {
            return true;
        }
    }
    return false;
};

// `import type { x }`, `import { type x }`, or `import type x = require(...)`.
const isTypeOnlySpecifier = (specifier, declaration) =>
    specifier.importKind === 'type' || declaration.importKind === 'type';

const isTypeOnlyImport = (definition) =>
    definition.type === 'ImportBinding' && isTypeOnlySpecifier(definition.node, definition.parent);

// Type-only and ambient definitions don't create a runtime binding, so the name still refers to
// the global.
const isRuntimeDefinition = (definition) =>
    definition.type !== 'Type' && !isTypeOnlyImport(definition) && !isAmbient(definition.node);

const getRuntimeVariable = (sourceCode, identifier) => {
    const scope = sourceCode.getScope(identifier);
    const variable = findVariable(scope, identifier.name);
    if (!variable) {
        return undefined;
    }
    return variable.defs.some(isRuntimeDefinition) ? variable : undefined;
};

// Applies `isLeaf` to each value a `?:`, `||`, `??`, or `&&` could produce: all of them when `every`
// is set, for trusting a receiver, or any of them otherwise, for locating a possible leak.
const matchesBranches = (node, isLeaf, every) => {
    const target = unwrap(node);
    switch (target?.type) {
        case 'ConditionalExpression': {
            const consequent = matchesBranches(target.consequent, isLeaf, every);
            const alternate = matchesBranches(target.alternate, isLeaf, every);
            return every ? consequent && alternate : consequent || alternate;
        }
        case 'LogicalExpression': {
            const right = matchesBranches(target.right, isLeaf, every);
            // An object is truthy, so `x && y` yields x only when x isn't one.
            const leftCanResult = every || target.operator !== '&&';
            const left = leftCanResult && matchesBranches(target.left, isLeaf, every);
            return every ? left && right : left || right;
        }
        default:
            return target !== undefined && isLeaf(target);
    }
};

const isGlobalObjectIdentifier = (sourceCode, node) =>
    node.type === 'Identifier' &&
    GLOBAL_OBJECTS.has(node.name) &&
    !getRuntimeVariable(sourceCode, node);

// `global` or `globalThis` on every path, not a local that shadows it, for trusting what's read
// off it.
const isDefinitelyGlobalObject = (sourceCode, node) =>
    matchesBranches(node, (leaf) => isGlobalObjectIdentifier(sourceCode, leaf), true);

// `global` or `globalThis` on some path.
const isGlobalObject = (sourceCode, node) =>
    matchesBranches(node, (leaf) => isGlobalObjectIdentifier(sourceCode, leaf), false);

// The built-in global or Jest export a name refers to: the name itself when nothing shadows it,
// the imported name for an import from @jest/globals, or the key read off the global object.
// Trusting a call takes the global object for certain; locating a reported one only for maybe.
const getGlobalName = (sourceCode, node, isGlobalAt = isDefinitelyGlobalObject) => {
    if (node.type === 'MemberExpression') {
        return isGlobalAt(sourceCode, node.object) ? getKeyName(node, node.property) : undefined;
    }
    if (node.type !== 'Identifier') {
        return undefined;
    }
    const variable = getRuntimeVariable(sourceCode, node);
    if (!variable) {
        return node.name;
    }
    const jestImport = variable.defs.find(
        (definition) =>
            definition.type === 'ImportBinding' &&
            definition.node.type === 'ImportSpecifier' &&
            getStaticString(definition.parent.source) === '@jest/globals',
    );
    return jestImport ? getImportedName(jestImport.node) : undefined;
};

// `name` or `object.method` for a call on a trusted global; undefined for anything else.
const getCalleeName = (sourceCode, node, isGlobalAt = isDefinitelyGlobalObject) => {
    const callee = unwrap(node);
    if (callee.type === 'Identifier') {
        return getGlobalName(sourceCode, callee, isGlobalAt);
    }
    if (callee.type !== 'MemberExpression') {
        return undefined;
    }
    const objectName = getGlobalName(sourceCode, callee.object, isGlobalAt);
    if (objectName === undefined) {
        return undefined;
    }
    const methodName = getKeyName(callee, callee.property);
    return `${objectName}.${methodName}`;
};

// `Object.prototype.hasOwnProperty.call(...)` on the built-in Object.
const isHasOwnPropertyCall = (sourceCode, callee) => {
    if (callee.type !== 'MemberExpression' || getKeyName(callee, callee.property) !== 'call') {
        return false;
    }
    const method = callee.object;
    if (
        method.type !== 'MemberExpression' ||
        getKeyName(method, method.property) !== 'hasOwnProperty'
    ) {
        return false;
    }
    const prototype = method.object;
    return (
        prototype.type === 'MemberExpression' &&
        getKeyName(prototype, prototype.property) === 'prototype' &&
        getGlobalName(sourceCode, prototype.object) === 'Object'
    );
};

// `process`, `global.process`, or `Reflect.get(globalThis, 'process')`, where `isGlobalAt` decides
// what counts as the global object.
const isProcessReference = (sourceCode, node, isGlobalAt) => {
    const target = unwrap(node);
    switch (target?.type) {
        case 'Identifier':
            return target.name === 'process' && !getRuntimeVariable(sourceCode, target);
        case 'MemberExpression':
            return (
                getKeyName(target, target.property) === 'process' &&
                isGlobalAt(sourceCode, target.object)
            );
        case 'CallExpression': {
            const [first, second] = target.arguments;
            const calleeName = getCalleeName(sourceCode, target.callee, isGlobalAt);
            return (
                calleeName === 'Reflect.get' &&
                isGlobalAt(sourceCode, first) &&
                getStaticString(second) === 'process'
            );
        }
        default:
            return false;
    }
};

// Whether an expression may be the global process. A value bound from it is reported where it's
// bound, so bindings are never followed.
const isProcess = (sourceCode, node) =>
    matchesBranches(node, (leaf) => isProcessReference(sourceCode, leaf, isGlobalObject), false);

// A call that loads the process module whole: require, jest.requireActual/requireMock, or
// process.getBuiltinModule.
const isProcessModuleLoad = (sourceCode, call) => {
    if (!isProcessModule(call.arguments[0])) {
        return false;
    }
    const calleeName = getCalleeName(sourceCode, call.callee, isGlobalObject);
    if (REQUIRE_CALLS.has(calleeName)) {
        return true;
    }
    const callee = unwrap(call.callee);
    return (
        callee.type === 'MemberExpression' &&
        getKeyName(callee, callee.property) === 'getBuiltinModule' &&
        isProcess(sourceCode, callee.object)
    );
};

// An object pattern that binds only named keys, never a rest copy of the whole object.
const isNamedKeyPattern = (node) =>
    node.type === 'ObjectPattern' &&
    node.properties.every((property) => property.type !== 'RestElement');

const getEnclosingFunction = (node) => {
    let current = node.parent;
    while (current && !FUNCTION_TYPES.has(current.type)) {
        current = current.parent;
    }
    return current;
};

const isHookCallback = (sourceCode, callback) => {
    const call = callback.parent;
    if (call.type !== 'CallExpression' || callback.params.length > 0) {
        return false;
    }
    const calleeName = getGlobalName(sourceCode, call.callee);
    return HOOKS.has(calleeName);
};

const isValueDiscarded = (sourceCode, node) => {
    const { parent } = node;
    if (TYPE_WRAPPERS.has(parent.type)) {
        return isValueDiscarded(sourceCode, parent);
    }
    if (
        parent.type === 'ExpressionStatement' ||
        (parent.type === 'UnaryExpression' && parent.operator === 'void')
    ) {
        return true;
    }
    if (parent.type === 'SequenceExpression') {
        const isLast = parent.expressions[parent.expressions.length - 1] === node;
        return !isLast || isValueDiscarded(sourceCode, parent);
    }
    if (parent.type === 'ArrowFunctionExpression' && parent.body === node) {
        return isHookCallback(sourceCode, parent);
    }
    if (parent.type === 'ReturnStatement') {
        const enclosingFunction = getEnclosingFunction(parent);
        return Boolean(enclosingFunction) && isHookCallback(sourceCode, enclosingFunction);
    }
    return parent.type === 'ForStatement' && (parent.init === node || parent.update === node);
};

// Climbs past wrappers so `process?.env`, `process.env as T`, and `(0, process.env)` are judged by
// what consumes them.
const getConsumer = (node) => {
    let child = node;
    let parent = node.parent;
    while (
        TYPE_WRAPPERS.has(parent.type) ||
        (parent.type === 'SequenceExpression' &&
            parent.expressions[parent.expressions.length - 1] === child)
    ) {
        child = parent;
        parent = parent.parent;
    }
    return { child, parent };
};

// The left side of `&&` is only tested, never returned when it's a live value.
const isAndGuard = (logical, operand) => logical.operator === '&&' && logical.left === operand;

// Like getConsumer, but also follows a value through `?:` branches and `&&`/`||`/`??` operands.
const getValueConsumer = (node) => {
    let { child, parent } = getConsumer(node);
    while (
        (parent.type === 'ConditionalExpression' && parent.test !== child) ||
        (parent.type === 'LogicalExpression' && !isAndGuard(parent, child))
    ) {
        ({ child, parent } = getConsumer(parent));
    }
    return { child, parent };
};

const isTestedOnly = (child, parent) =>
    (TEST_POSITIONS.has(parent.type) && parent.test === child) ||
    (parent.type === 'LogicalExpression' && isAndGuard(parent, child)) ||
    (parent.type === 'UnaryExpression' && parent.operator === '!');

const isKeyedCallTarget = (sourceCode, call, argument) => {
    if (call.arguments[0] !== argument) {
        return false;
    }
    const calleeName = getCalleeName(sourceCode, call.callee);
    if (KEYED_CALLS.has(calleeName) || isHasOwnPropertyCall(sourceCode, call.callee)) {
        return true;
    }
    return TARGET_RETURNING_CALLS.has(calleeName) && isValueDiscarded(sourceCode, call);
};

// The object pattern a value is destructured into: a declarator's init, a default's value, or the
// right side of a discarded assignment, since `a = b` evaluates to b.
const getDestructuringPattern = (sourceCode, child, parent) => {
    let target;
    if (parent.type === 'VariableDeclarator' && parent.init === child) {
        target = parent.id;
    } else if (parent.type === 'AssignmentPattern' && parent.right === child) {
        target = parent.left;
    } else if (
        parent.type === 'AssignmentExpression' &&
        parent.right === child &&
        isValueDiscarded(sourceCode, parent)
    ) {
        target = parent.left;
    }
    return target?.type === 'ObjectPattern' ? target : undefined;
};

const isSafeEnvUse = (sourceCode, envNode) => {
    const { child, parent } = getValueConsumer(envNode);
    if (isTestedOnly(child, parent)) {
        return true;
    }
    const pattern = getDestructuringPattern(sourceCode, child, parent);
    if (pattern) {
        return isSafeEnvPattern(pattern);
    }
    switch (parent.type) {
        case 'MemberExpression': {
            const keyName = getKeyName(parent, parent.property);
            return parent.object === child && !isLeakingKey(keyName, true);
        }
        case 'BinaryExpression':
            return parent.operator === 'in' && parent.right === child;
        case 'ForInStatement':
            return parent.right === child;
        case 'UnaryExpression':
            return parent.operator === 'typeof';
        case 'CallExpression': {
            const keyName = getStaticString(parent.arguments[1]);
            return isKeyedCallTarget(sourceCode, parent, child) && !isLeakingKey(keyName, true);
        }
        default:
            return false;
    }
};

// Calls the rule reports on their own: reading or replacing a key of process that holds, produces,
// or hands back the env, or reading the descriptor of, replacing, or deleting global process.
const isReportedCall = (sourceCode, call) => {
    const calleeName = getCalleeName(sourceCode, call.callee, isGlobalObject);
    const [target, key] = call.arguments;
    const keyName = getStaticString(key);
    const sources = call.arguments.slice(1);
    const targetIsProcess = isProcess(sourceCode, target);
    const checksExistence = EXISTENCE_CHECKS.has(calleeName);
    const replacesOrReadsLeakingKey =
        isKeyedCallName(calleeName) &&
        targetIsProcess &&
        isLeakingKey(keyName, false) &&
        !checksExistence;
    const replacesEnvFromLiteral =
        targetIsProcess &&
        PROPERTY_REPLACERS.has(calleeName) &&
        sources.some((source) => mayHaveProperty(source, 'env'));
    const replacesGlobalProcessFromLiteral =
        PROPERTY_REPLACERS.has(calleeName) &&
        isGlobalObject(sourceCode, target) &&
        sources.some((source) => mayHaveProperty(source, 'process'));
    // A descriptor read hands back process through its value or getter.
    const touchesGlobalProcess =
        (KEYED_REPLACERS.has(calleeName) || DESCRIPTOR_READERS.has(calleeName)) &&
        keyName === 'process' &&
        isGlobalObject(sourceCode, target);
    return (
        replacesOrReadsLeakingKey ||
        replacesEnvFromLiteral ||
        replacesGlobalProcessFromLiteral ||
        touchesGlobalProcess
    );
};

// A use of process that reads named properties or names, tests or compares it, applies an operator
// other than `delete` or the left side of `instanceof`, discards it, or destructures named keys of
// it (checked on their own). Binding or passing it whole could copy or print process.env with it.
const isSafeProcessUse = (sourceCode, processNode) => {
    const { child, parent } = getValueConsumer(processNode);
    if (isValueDiscarded(sourceCode, child) || isTestedOnly(child, parent)) {
        return true;
    }
    if (getDestructuringPattern(sourceCode, child, parent)) {
        return true;
    }
    if (TYPE_REFERENCE_PARENTS.has(parent.type)) {
        return true;
    }
    switch (parent.type) {
        case 'MemberExpression': {
            // process.env is checked on its own; a computed `x[process]` has no static key.
            const keyName = getKeyName(parent, parent.property);
            return keyName === 'env' || !isLeakingKey(keyName, false);
        }
        case 'BinaryExpression':
            // instanceof passes its left operand to the right operand's Symbol.hasInstance.
            return parent.operator !== 'instanceof' || parent.right === child;
        case 'UnaryExpression':
            return parent.operator !== 'delete';
        case 'ForInStatement':
            return parent.right === child;
        case 'CallExpression':
            return isKeyedCallTarget(sourceCode, parent, child);
        default:
            return false;
    }
};

// The names of a dotted `import =` path, as in `globalThis.process.env`.
const getQualifiedNames = (name) =>
    name.type === 'TSQualifiedName' ? [...getQualifiedNames(name.left), name.right] : [name];

// `import x = process.env` or `import x = globalThis.process`: an alias of process, of
// process.env itself, or of a key isLeakingKey refuses, as their member reads are. Reference checks
// treat the path's root as a type position, so it's checked here.
const aliasesProcessPath = (sourceCode, names) => {
    const [root, second] = names;
    let processIndex = -1;
    if (isProcess(sourceCode, root)) {
        processIndex = 0;
    } else if (isGlobalObject(sourceCode, root) && second.name === 'process') {
        processIndex = 1;
    }
    if (processIndex === -1) {
        return false;
    }
    const key = names[processIndex + 1];
    if (key === undefined) {
        return true;
    }
    if (key.name !== 'env') {
        return isLeakingKey(key.name, false);
    }
    const envKey = names[processIndex + 2];
    return envKey === undefined || isLeakingKey(envKey.name, true);
};

// A keyed call that reads or redefines an accessor helper, as in
// `Reflect.get(Object.prototype, '__lookupGetter__')`. Checking for the key is fine.
const readsAccessorHelper = (sourceCode, call) => {
    const calleeName = getCalleeName(sourceCode, call.callee, isGlobalObject);
    const keyName = getStaticString(call.arguments[1]);
    return (
        isKeyedCallName(calleeName) &&
        !EXISTENCE_CHECKS.has(calleeName) &&
        ACCESSOR_HELPERS.has(keyName)
    );
};

// A call that replaces process.env, as in `jest.replaceProperty(process, 'env', …)`.
const replacesProcessEnv = (sourceCode, call) => {
    const calleeName = getCalleeName(sourceCode, call.callee, isGlobalObject);
    const [target, key] = call.arguments;
    return (
        KEYED_REPLACERS.has(calleeName) &&
        getStaticString(key) === 'env' &&
        isProcess(sourceCode, target)
    );
};

// A pattern destructuring process.env into named keys, none of them one that leaks.
const isSafeEnvPattern = (pattern) =>
    isNamedKeyPattern(pattern) &&
    pattern.properties.every((property) => {
        const keyName = getKeyName(property, property.key);
        return !isLeakingKey(keyName, true);
    });

const isSafeEnvBinding = (value) =>
    isSafeEnvPattern(value.type === 'AssignmentPattern' ? value.left : value);

// The expression a pattern destructures: a declarator's init, an assignment's right side, or a
// default's value.
const getPatternSource = (pattern) => {
    const { parent } = pattern;
    if (parent.type === 'VariableDeclarator' && parent.id === pattern) {
        return parent.init;
    }
    if (
        (parent.type === 'AssignmentExpression' || parent.type === 'AssignmentPattern') &&
        parent.left === pattern
    ) {
        return parent.right;
    }
    return undefined;
};

// `process.env = …` is reported as the whole assignment, the replacement itself.
const getEnvReportTarget = (envNode) => {
    const { child, parent } = getConsumer(envNode);
    return parent.type === 'AssignmentExpression' && parent.left === child ? parent : envNode;
};

// The last call in a chain such as `jest.spyOn(…).mockReturnValue(…)`, so its arguments count as
// part of the reported call.
const getCallChainEnd = (call) => {
    let current = call;
    while (
        current.parent.type === 'MemberExpression' &&
        current.parent.object === current &&
        current.parent.parent.type === 'CallExpression' &&
        current.parent.parent.callee === current.parent
    ) {
        current = current.parent.parent;
    }
    return current;
};

// Whether a source object can carry the `name` key: only an object literal whose static keys
// leave it out provably can't.
const mayHaveProperty = (node, name) => {
    if (node?.type !== 'ObjectExpression') {
        return true;
    }
    return node.properties.some((property) => {
        const keyName =
            property.type === 'Property' ? getKeyName(property, property.key) : undefined;
        return keyName === undefined || keyName === name;
    });
};

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow using process.env as a whole value in tests.',
        },
        messages: { wholeProcessEnv: MESSAGE, accessorHelper: ACCESSOR_HELPER_MESSAGE },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context;
        // One report per leak: a node inside an already-reported node on the same line isn't
        // reported again. A nested leak on a later line is its own, so a line-level disable on the
        // outer report can't hide it.
        const reportedNodes = new WeakSet();
        const report = (node) => {
            for (let current = node; current; current = current.parent) {
                const isSameLine = current.loc.start.line === node.loc.start.line;
                if (reportedNodes.has(current) && isSameLine) {
                    return;
                }
            }
            reportedNodes.add(node);
            context.report({ node, messageId: 'wholeProcessEnv' });
        };

        // `...process.env` spread into an object literal that's the right side or an argument of a
        // reported env replacement, as in `process.env = { ...process.env, X: '1' }`, is part of
        // that leak on any line. A spread nested deeper, such as in a descriptor's value, is its
        // own report.
        const envReplacements = new WeakSet();
        const isSpreadIntoEnvReplacement = (envNode) => {
            const { parent } = getConsumer(envNode);
            const container = parent.type === 'SpreadElement' ? parent.parent : undefined;
            if (container?.type !== 'ObjectExpression') {
                return false;
            }
            const containerConsumer = getConsumer(container);
            const replacement = getCallChainEnd(containerConsumer.parent);
            return envReplacements.has(replacement);
        };

        const reportAccessorHelper = (node) => {
            context.report({ node, messageId: 'accessorHelper' });
        };

        const checkProcessExpression = (node) => {
            if (isProcess(sourceCode, node) && !isSafeProcessUse(sourceCode, node)) {
                report(node);
            }
        };

        // A pattern destructuring process: a rest copy, env bound other than to named keys of it,
        // report, or a method that hands back process.
        const checkProcessPattern = (pattern) => {
            for (const property of pattern.properties) {
                if (property.type === 'RestElement') {
                    report(property);
                    continue;
                }
                const keyName = getKeyName(property, property.key);
                const isUnsafeEnv = keyName === 'env' && !isSafeEnvBinding(property.value);
                const isUnsafeKey = keyName !== 'env' && isLeakingKey(keyName, false);
                if (isUnsafeEnv || isUnsafeKey) {
                    report(property);
                }
            }
        };

        // A pattern destructuring the global object: its `process` key is process itself.
        const checkGlobalObjectPattern = (pattern) => {
            for (const property of pattern.properties) {
                const isProcessKey =
                    property.type === 'Property' &&
                    getKeyName(property, property.key) === 'process';
                if (!isProcessKey) {
                    continue;
                }
                const { value } = property;
                const innerPattern = value.type === 'AssignmentPattern' ? value.left : value;
                if (innerPattern.type === 'ObjectPattern') {
                    checkProcessPattern(innerPattern);
                } else {
                    report(property);
                }
            }
        };

        return {
            'Program:exit'() {
                for (const scope of sourceCode.scopeManager.scopes) {
                    for (const reference of scope.references) {
                        const { identifier } = reference;
                        const isTypeOnly = reference.isValueReference === false;
                        if (reference.isRead() && !isTypeOnly) {
                            checkProcessExpression(identifier);
                        }
                        // The helpers are also globals inherited from Object.prototype.
                        const isGlobalHelper =
                            ACCESSOR_HELPERS.has(identifier.name) &&
                            !TYPE_REFERENCE_PARENTS.has(identifier.parent.type) &&
                            !getRuntimeVariable(sourceCode, identifier);
                        if (isGlobalHelper && !isTypeOnly) {
                            reportAccessorHelper(identifier);
                        }
                        // A destructuring or for...of/in target that replaces the global process.
                        if (reference.isWrite() && isProcess(sourceCode, identifier)) {
                            report(identifier);
                        }
                    }
                }
            },
            MemberExpression(node) {
                const keyName = getKeyName(node, node.property);
                if (ACCESSOR_HELPERS.has(keyName)) {
                    reportAccessorHelper(node);
                }
                const isEnv = keyName === 'env' && isProcess(sourceCode, node.object);
                const isUnsafeEnv = isEnv && !isSafeEnvUse(sourceCode, node);
                if (isUnsafeEnv && !isSpreadIntoEnvReplacement(node)) {
                    const target = getEnvReportTarget(node);
                    report(target);
                    if (target !== node) {
                        envReplacements.add(target);
                    }
                }
                if (keyName === 'process') {
                    checkProcessExpression(node);
                }
            },
            Property(node) {
                const keyName = getKeyName(node, node.key);
                const isHelperPatternKey =
                    ACCESSOR_HELPERS.has(keyName) && node.parent.type === 'ObjectPattern';
                if (isHelperPatternKey) {
                    reportAccessorHelper(node);
                }
            },
            ObjectPattern(node) {
                const source = getPatternSource(node);
                if (!source) {
                    return;
                }
                if (isProcess(sourceCode, source)) {
                    checkProcessPattern(node);
                }
                if (isGlobalObject(sourceCode, source)) {
                    checkGlobalObjectPattern(node);
                }
            },
            AssignmentExpression(node) {
                // `process = …` or `global.process = …` replaces the global process.
                if (isProcess(sourceCode, node.left)) {
                    report(node);
                }
            },
            CallExpression(node) {
                if (isReportedCall(sourceCode, node)) {
                    const chainEnd = getCallChainEnd(node);
                    report(chainEnd);
                    if (replacesProcessEnv(sourceCode, node)) {
                        envReplacements.add(chainEnd);
                    }
                }
                if (isProcessModuleLoad(sourceCode, node)) {
                    report(node);
                }
                if (readsAccessorHelper(sourceCode, node)) {
                    reportAccessorHelper(node);
                }
                checkProcessExpression(node);
            },
            ImportExpression(node) {
                if (isProcessModule(node.source)) {
                    report(node);
                }
            },
            ImportSpecifier(node) {
                const importedName = getImportedName(node);
                const isTypeOnly = isTypeOnlySpecifier(node, node.parent);
                if (!isTypeOnly && ACCESSOR_HELPERS.has(importedName)) {
                    reportAccessorHelper(node);
                }
            },
            ImportDeclaration(node) {
                if (node.importKind === 'type' || !isProcessModule(node.source)) {
                    return;
                }
                for (const specifier of node.specifiers) {
                    if (specifier.type !== 'ImportSpecifier') {
                        report(specifier);
                        continue;
                    }
                    const importedName = getImportedName(specifier);
                    const bindsEnvOrProcess =
                        importedName === 'default' || isLeakingKey(importedName, false);
                    if (specifier.importKind !== 'type' && bindsEnvOrProcess) {
                        report(specifier);
                    }
                }
            },
            TSImportEqualsDeclaration(node) {
                const reference = node.moduleReference;
                if (node.importKind === 'type') {
                    return;
                }
                const importsProcessModule =
                    reference.type === 'TSExternalModuleReference' &&
                    isProcessModule(reference.expression);
                const names =
                    reference.type === 'TSQualifiedName' ? getQualifiedNames(reference) : [];
                const aliasesProcess = names.length > 0 && aliasesProcessPath(sourceCode, names);
                if (importsProcessModule || aliasesProcess) {
                    report(node);
                }
                if (names.some((name) => ACCESSOR_HELPERS.has(name.name))) {
                    reportAccessorHelper(node);
                }
            },
            ExportAllDeclaration(node) {
                if (node.exportKind !== 'type' && isProcessModule(node.source)) {
                    report(node);
                }
            },
            ExportSpecifier(node) {
                const declaration = node.parent;
                const isTypeOnly = node.exportKind === 'type' || declaration.exportKind === 'type';
                const localName = getModuleExportName(node.local);
                const reExportsEnvOrProcess =
                    declaration.source &&
                    isProcessModule(declaration.source) &&
                    (localName === 'default' || isLeakingKey(localName, false));
                if (!isTypeOnly && reExportsEnvOrProcess) {
                    report(node);
                }
                if (!isTypeOnly && declaration.source && ACCESSOR_HELPERS.has(localName)) {
                    reportAccessorHelper(node);
                }
            },
        };
    },
};
