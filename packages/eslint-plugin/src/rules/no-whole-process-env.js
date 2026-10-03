// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Test runs start with CI secrets in their env, so a whole-env copy can carry any the setup scrub
// misses into failure output.
const MESSAGE =
    "Don't use process.env as a whole value in tests (reassign, replace, alias, spread, pass, or assert on it, or pass, return, or copy process itself). Read, set, or delete single keys, check for one with `'KEY' in process.env`, list names with Object.keys(process.env), reset Datadog keys with clearDatadogEnv() from @dd/tests/_jest/helpers/datadogEnv, and give child processes an env built from only the keys they need.";

const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['global', 'globalThis']);
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
// Calls that only check for the env key when given (process, 'env').
const EXISTENCE_CHECKS = new Set(['Object.hasOwn', 'Reflect.has']);
// Calls that replace properties of their first argument from an object literal.
const PROPERTY_REPLACERS = new Set(['Object.assign', 'Object.defineProperties']);
const REQUIRE_CALLS = new Set(['require', 'jest.requireActual', 'jest.requireMock']);
// EventEmitter methods that return the emitter, so on process they return process itself.
const SELF_RETURNING_METHODS = new Set([
    'addListener',
    'off',
    'on',
    'once',
    'prependListener',
    'prependOnceListener',
    'removeAllListeners',
    'removeListener',
    'setMaxListeners',
]);
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
// Calls that replace a named property when given (target, 'name', ...).
const KEYED_REPLACERS = new Set([
    'jest.replaceProperty',
    'Object.defineProperty',
    'Reflect.defineProperty',
    'Reflect.set',
]);

const getStaticString = (node) => {
    if (node?.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0].value.cooked;
    }
    return undefined;
};

// The static name of a MemberExpression's property or a Property's key.
const getKeyName = (node, key) => {
    if (!node.computed && key.type === 'Identifier') {
        return key.name;
    }
    return getStaticString(key);
};

const getCalleeName = (callee) => {
    if (callee.type === 'Identifier') {
        return callee.name;
    }
    if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') {
        return undefined;
    }
    const methodName = getKeyName(callee, callee.property);
    return `${callee.object.name}.${methodName}`;
};

const isHasOwnPropertyCall = (callee) =>
    callee.type === 'MemberExpression' &&
    getKeyName(callee, callee.property) === 'call' &&
    callee.object.type === 'MemberExpression' &&
    getKeyName(callee.object, callee.object.property) === 'hasOwnProperty';

const isProcessModule = (node) => {
    const specifier = getStaticString(node);
    return PROCESS_MODULES.has(specifier);
};

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

const findVariable = (scope, name) => {
    for (let current = scope; current; current = current.upper) {
        const variable = current.set.get(name);
        if (variable) {
            return variable;
        }
    }
    return undefined;
};

// Type-only and `declare`d definitions don't create a runtime binding, so the name still refers
// to the global.
const isRuntimeDefinition = (definition) => {
    if (definition.type === 'Type') {
        return false;
    }
    const isDeclared = definition.type === 'Variable' && definition.parent?.declare === true;
    return !isDeclared;
};

const getRuntimeVariable = (sourceCode, identifier) => {
    const scope = sourceCode.getScope(identifier);
    const variable = findVariable(scope, identifier.name);
    const hasRuntimeDefinition = variable?.defs.some(isRuntimeDefinition);
    return hasRuntimeDefinition ? variable : undefined;
};

// Every identifier that binds a value to the variable: its definitions and its writes.
const getBindings = (variable) => {
    const writes = variable.references
        .filter((reference) => reference.isWrite())
        .map((reference) => reference.identifier);
    const definitionNames = variable.defs.map((definition) => definition.name);
    return [...new Set([...definitionNames, ...writes])];
};

// Whether any binding of `variable` comes from a source `matchesSource` accepts. Results are cached
// per variable, but only for top-level lookups, so a cycle cut short can't be cached.
const isVariableBoundFrom = (
    sourceCode,
    variable,
    cache,
    seen,
    matchesSource,
    followsProcessKeys,
) => {
    if (cache.has(variable)) {
        return cache.get(variable);
    }
    if (seen.has(variable)) {
        return false;
    }
    const isTopLevel = seen.size === 0;
    seen.add(variable);
    const result = getBindings(variable).some((binding) =>
        isBoundFrom(sourceCode, binding, matchesSource, followsProcessKeys),
    );
    if (isTopLevel) {
        cache.set(variable, result);
    }
    return result;
};

const globalObjectVariables = new WeakMap();
const processModulePromiseVariables = new WeakMap();
const processVariables = new WeakMap();

const isGlobalObject = (sourceCode, node, seen = new Set()) => {
    const target = unwrap(node);
    if (target?.type === 'ConditionalExpression') {
        return (
            isGlobalObject(sourceCode, target.consequent, seen) ||
            isGlobalObject(sourceCode, target.alternate, seen)
        );
    }
    if (target?.type === 'LogicalExpression') {
        return (
            isGlobalObject(sourceCode, target.left, seen) ||
            isGlobalObject(sourceCode, target.right, seen)
        );
    }
    if (target?.type !== 'Identifier') {
        return false;
    }
    const variable = getRuntimeVariable(sourceCode, target);
    if (!variable) {
        return GLOBAL_OBJECTS.has(target.name);
    }
    return isVariableBoundFrom(
        sourceCode,
        variable,
        globalObjectVariables,
        seen,
        (source) => isGlobalObject(sourceCode, source, seen),
        false,
    );
};

const isProcessImport = (definition) => {
    const { node } = definition;
    if (node.type === 'TSImportEqualsDeclaration') {
        const reference = node.moduleReference;
        return (
            reference.type === 'TSExternalModuleReference' && isProcessModule(reference.expression)
        );
    }
    const importsWholeModule =
        node.type === 'ImportDefaultSpecifier' ||
        node.type === 'ImportNamespaceSpecifier' ||
        (node.type === 'ImportSpecifier' && node.imported.name === 'default');
    return importsWholeModule && isProcessModule(definition.parent.source);
};

// A promise for the process module: `import('process')`, directly or through an alias.
const isProcessModulePromise = (sourceCode, node, seen = new Set()) => {
    const target = unwrap(node);
    if (target?.type === 'ImportExpression') {
        return isProcessModule(target.source);
    }
    if (target?.type !== 'Identifier') {
        return false;
    }
    const variable = getRuntimeVariable(sourceCode, target);
    if (!variable) {
        return false;
    }
    return isVariableBoundFrom(
        sourceCode,
        variable,
        processModulePromiseVariables,
        seen,
        (source) => isProcessModulePromise(sourceCode, source, seen),
        false,
    );
};

// The first parameter of a `.then` callback on a promise for the process module.
const isProcessModuleThenParameter = (sourceCode, callback, parameter) => {
    const call = callback.parent;
    const isThenCallback =
        callback.params[0] === parameter &&
        call.type === 'CallExpression' &&
        call.arguments[0] === callback &&
        call.callee.type === 'MemberExpression' &&
        getKeyName(call.callee, call.callee.property) === 'then';
    return isThenCallback && isProcessModulePromise(sourceCode, call.callee.object);
};

// Whether the value bound at a binding position (an identifier or a pattern) comes whole from a
// source that `matchesSource` accepts: a declarator, assignment, or default, walking out of
// defaults. Loop variables and other destructured keys get only part of a value, so they don't
// count. With `followsProcessKeys`, two keys whose value is process itself do: `process` on a
// pattern bound to the global object, and `default` on a pattern bound to process. So does the
// first parameter of a `.then` callback on `import('process')`.
const isBoundFrom = (sourceCode, target, matchesSource, followsProcessKeys) => {
    const { parent } = target;
    switch (parent.type) {
        case 'VariableDeclarator':
            return parent.id === target && parent.init !== null && matchesSource(parent.init);
        case 'AssignmentExpression':
            return parent.left === target && matchesSource(parent.right);
        case 'AssignmentPattern':
            return (
                parent.left === target &&
                (matchesSource(parent.right) ||
                    isBoundFrom(sourceCode, parent, matchesSource, followsProcessKeys))
            );
        case 'Property': {
            if (
                !followsProcessKeys ||
                parent.value !== target ||
                parent.parent.type !== 'ObjectPattern'
            ) {
                return false;
            }
            const keyName = getKeyName(parent, parent.key);
            const isProcessOfGlobal =
                keyName === 'process' && isBoundToGlobalObject(sourceCode, parent.parent);
            const isDefaultOfProcess =
                keyName === 'default' &&
                isBoundFrom(sourceCode, parent.parent, matchesSource, followsProcessKeys);
            return isProcessOfGlobal || isDefaultOfProcess;
        }
        default:
            return (
                followsProcessKeys &&
                FUNCTION_TYPES.has(parent.type) &&
                isProcessModuleThenParameter(sourceCode, parent, target)
            );
    }
};

const isBoundToGlobalObject = (sourceCode, target) =>
    isBoundFrom(sourceCode, target, (source) => isGlobalObject(sourceCode, source), false);

const isBoundToProcess = (sourceCode, target, seen = new Set()) =>
    isBoundFrom(sourceCode, target, (source) => isProcess(sourceCode, source, seen), true);

// `process` or `global.process` as an assignment target, which replaces the global process.
const isGlobalProcessTarget = (sourceCode, node) => {
    const target = unwrap(node);
    if (target?.type === 'Identifier') {
        return target.name === 'process' && !getRuntimeVariable(sourceCode, target);
    }
    return (
        target?.type === 'MemberExpression' &&
        getKeyName(target, target.property) === 'process' &&
        isGlobalObject(sourceCode, target.object)
    );
};

// Whether an expression evaluates to the process object (or the process module's namespace).
const isProcess = (sourceCode, node, seen = new Set()) => {
    const target = unwrap(node);
    if (!target) {
        return false;
    }
    switch (target.type) {
        case 'Identifier': {
            const variable = getRuntimeVariable(sourceCode, target);
            if (!variable) {
                return target.name === 'process';
            }
            const isImported = variable.defs.some(
                (definition) => definition.type === 'ImportBinding' && isProcessImport(definition),
            );
            return (
                isImported ||
                isVariableBoundFrom(
                    sourceCode,
                    variable,
                    processVariables,
                    seen,
                    (source) => isProcess(sourceCode, source, seen),
                    true,
                )
            );
        }
        case 'MemberExpression': {
            const keyName = getKeyName(target, target.property);
            const isProcessOfGlobal =
                keyName === 'process' && isGlobalObject(sourceCode, target.object);
            // A dynamic import's namespace exposes process as its default export.
            const isDefaultOfProcess =
                keyName === 'default' && isProcess(sourceCode, target.object, seen);
            return isProcessOfGlobal || isDefaultOfProcess;
        }
        case 'ConditionalExpression':
            return (
                isProcess(sourceCode, target.consequent, seen) ||
                isProcess(sourceCode, target.alternate, seen)
            );
        case 'LogicalExpression':
            // process is truthy, so `process && x` is x; the left side matters only for || and ??.
            return (
                (target.operator !== '&&' && isProcess(sourceCode, target.left, seen)) ||
                isProcess(sourceCode, target.right, seen)
            );
        case 'CallExpression': {
            const [first, second] = target.arguments;
            const calleeName = getCalleeName(target.callee);
            const isRequire = REQUIRE_CALLS.has(calleeName);
            const readsGlobalProcess =
                calleeName === 'Reflect.get' &&
                isGlobalObject(sourceCode, first) &&
                getStaticString(second) === 'process';
            const { callee } = target;
            const returnsProcess =
                callee.type === 'MemberExpression' &&
                SELF_RETURNING_METHODS.has(getKeyName(callee, callee.property)) &&
                isProcess(sourceCode, callee.object, seen);
            return (isRequire && isProcessModule(first)) || readsGlobalProcess || returnsProcess;
        }
        case 'AwaitExpression':
            return isProcessModulePromise(sourceCode, target.argument);
        default:
            return false;
    }
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
    return current ?? undefined;
};

// A hook name bound to Jest's global, or imported from @jest/globals under its own name.
const isJestHookName = (sourceCode, callee) => {
    if (callee?.type !== 'Identifier' || !HOOKS.has(callee.name)) {
        return false;
    }
    const variable = getRuntimeVariable(sourceCode, callee);
    if (!variable) {
        return true;
    }
    return variable.defs.some(
        (definition) =>
            definition.type === 'ImportBinding' &&
            definition.node.type === 'ImportSpecifier' &&
            definition.node.imported.name === callee.name &&
            getStaticString(definition.parent.source) === '@jest/globals',
    );
};

const isHookCallback = (sourceCode, callback) => {
    const call = callback.parent;
    const callee = call.type === 'CallExpression' ? call.callee : undefined;
    return isJestHookName(sourceCode, callee) && callback.params.length === 0;
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
        return enclosingFunction !== undefined && isHookCallback(sourceCode, enclosingFunction);
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

const isKeyedCallTarget = (sourceCode, call, argument) => {
    if (call.arguments[0] !== argument) {
        return false;
    }
    const calleeName = getCalleeName(call.callee);
    if (KEYED_CALLS.has(calleeName) || isHasOwnPropertyCall(call.callee)) {
        return true;
    }
    return TARGET_RETURNING_CALLS.has(calleeName) && isValueDiscarded(sourceCode, call);
};

const isSafeEnvUse = (sourceCode, envNode) => {
    const { child, parent } = getConsumer(envNode);
    switch (parent.type) {
        case 'MemberExpression':
            return parent.object === child && getKeyName(parent, parent.property) !== 'valueOf';
        case 'BinaryExpression':
            return parent.operator === 'in' && parent.right === child;
        case 'ForInStatement':
            return parent.right === child;
        case 'UnaryExpression':
            return parent.operator === 'typeof';
        case 'CallExpression':
            return isKeyedCallTarget(sourceCode, parent, child);
        case 'VariableDeclarator':
            return parent.init === child && isNamedKeyPattern(parent.id);
        case 'AssignmentExpression':
            return (
                parent.right === child &&
                isNamedKeyPattern(parent.left) &&
                isValueDiscarded(sourceCode, parent)
            );
        case 'AssignmentPattern':
            return parent.right === child && isNamedKeyPattern(parent.left);
        default:
            return false;
    }
};

// The left side of `&&` is only tested, never returned when it's process.
const isAndGuard = (logical, operand) => logical.operator === '&&' && logical.left === operand;

const THIS_BINDING_METHODS = new Set(['apply', 'bind', 'call']);

// process passed as `this`, as in `process.exit.bind(process)` or `Reflect.apply(fn, process, args)`.
const isThisArgument = (call, argument) => {
    const { callee } = call;
    if (getCalleeName(callee) === 'Reflect.apply') {
        return call.arguments[1] === argument;
    }
    if (callee.type !== 'MemberExpression') {
        return false;
    }
    const methodName = getKeyName(callee, callee.property);
    return THIS_BINDING_METHODS.has(methodName) && call.arguments[0] === argument;
};

// `process.report.getReport()`, whose result holds every environment variable.
const isProcessReportRead = (sourceCode, call) => {
    const { callee } = call;
    return (
        callee.type === 'MemberExpression' &&
        getKeyName(callee, callee.property) === 'getReport' &&
        callee.object.type === 'MemberExpression' &&
        getKeyName(callee.object, callee.object.property) === 'report' &&
        isProcess(sourceCode, callee.object.object)
    );
};

// Calls the rule reports on their own: reading or replacing process.env, replacing global
// process, or reading a process report.
const isReportedCall = (sourceCode, call) => {
    const calleeName = getCalleeName(call.callee);
    const [target, key] = call.arguments;
    const keyName = getStaticString(key);
    const sources = call.arguments.slice(1);
    const targetIsProcess = target !== undefined && isProcess(sourceCode, target);
    const checksExistence = EXISTENCE_CHECKS.has(calleeName) || isHasOwnPropertyCall(call.callee);
    const replacesOrReadsEnv = targetIsProcess && keyName === 'env' && !checksExistence;
    const replacesEnvFromLiteral =
        targetIsProcess &&
        PROPERTY_REPLACERS.has(calleeName) &&
        sources.some((source) => hasNamedProperty(source, 'env'));
    const replacesGlobalProcessFromLiteral =
        PROPERTY_REPLACERS.has(calleeName) &&
        isGlobalObject(sourceCode, target) &&
        sources.some((source) => hasNamedProperty(source, 'process'));
    const replacesGlobalProcess =
        KEYED_REPLACERS.has(calleeName) &&
        keyName === 'process' &&
        isGlobalObject(sourceCode, target);
    return (
        replacesOrReadsEnv ||
        replacesEnvFromLiteral ||
        replacesGlobalProcess ||
        replacesGlobalProcessFromLiteral ||
        isProcessReportRead(sourceCode, call)
    );
};

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

// A use of process that reads named properties or names, tests it, or binds it somewhere the rule
// follows (an alias or a destructure; exported bindings are checked on their own). Anything else
// could copy or print process.env with it.
const isSafeProcessUse = (sourceCode, processNode) => {
    const { child, parent } = getValueConsumer(processNode);
    if (isValueDiscarded(sourceCode, child)) {
        return true;
    }
    const isTested =
        (TEST_POSITIONS.has(parent.type) && parent.test === child) ||
        (parent.type === 'LogicalExpression' && isAndGuard(parent, child));
    if (isTested) {
        return true;
    }
    switch (parent.type) {
        case 'MemberExpression':
            return parent.object !== child || getKeyName(parent, parent.property) !== 'valueOf';
        case 'BinaryExpression':
        case 'ExpressionStatement':
        case 'TSQualifiedName':
        case 'TSTypeQuery':
            return true;
        case 'UnaryExpression':
            return parent.operator !== 'delete';
        case 'ForInStatement':
            return parent.right === child;
        case 'CallExpression':
            return isKeyedCallTarget(sourceCode, parent, child) || isThisArgument(parent, child);
        case 'VariableDeclarator':
        case 'AssignmentPattern':
            return true;
        case 'AssignmentExpression': {
            // `a ||= b` and `a ??= b` evaluate to `a` when it's already set.
            if (parent.left === child) {
                return isValueDiscarded(sourceCode, parent);
            }
            if (isGlobalProcessTarget(sourceCode, parent.left)) {
                return true;
            }
            const bindsFollowedTarget =
                parent.left.type === 'Identifier' || parent.left.type === 'ObjectPattern';
            return bindsFollowedTarget && isValueDiscarded(sourceCode, parent);
        }
        default:
            return false;
    }
};

// A use of a promise for the process module that the rule follows: awaiting it, an inline `.then`
// callback, or a local alias.
const isSafeProcessModulePromiseUse = (sourceCode, promiseNode) => {
    const { child, parent } = getConsumer(promiseNode);
    switch (parent.type) {
        case 'AwaitExpression':
        case 'ExpressionStatement':
            return true;
        case 'VariableDeclarator':
            return parent.id.type === 'Identifier';
        case 'AssignmentExpression':
            return (
                (parent.left === child || parent.left.type === 'Identifier') &&
                isValueDiscarded(sourceCode, parent)
            );
        case 'MemberExpression': {
            const call = parent.parent;
            const callback = call.type === 'CallExpression' ? call.arguments[0] : undefined;
            return (
                parent.object === child &&
                getKeyName(parent, parent.property) === 'then' &&
                call.callee === parent &&
                callback !== undefined &&
                FUNCTION_TYPES.has(callback.type)
            );
        }
        default:
            return false;
    }
};

// A destructured `env` value that binds only named keys, with or without a default.
const isSafeEnvBinding = (value) =>
    isNamedKeyPattern(value) ||
    (value.type === 'AssignmentPattern' && isNamedKeyPattern(value.left));

// `process.env = …` is reported as the whole assignment, so a spread of process.env on its right
// side counts as the same leak.
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

const hasNamedProperty = (node, name) =>
    node?.type === 'ObjectExpression' &&
    node.properties.some(
        (property) => property.type === 'Property' && getKeyName(property, property.key) === name,
    );

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow using process.env as a whole value in tests.',
        },
        messages: { wholeProcessEnv: MESSAGE },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context;
        // One report per leak: a node inside an already-reported node isn't reported again.
        const reportedNodes = new WeakSet();
        const report = (node) => {
            for (let current = node; current; current = current.parent) {
                if (reportedNodes.has(current)) {
                    return;
                }
            }
            reportedNodes.add(node);
            context.report({ node, messageId: 'wholeProcessEnv' });
        };

        const checkProcessExpression = (node) => {
            if (isProcess(sourceCode, node) && !isSafeProcessUse(sourceCode, node)) {
                report(node);
            }
        };
        const isProcessValue = (identifier) =>
            isProcess(sourceCode, identifier) || isProcessModulePromise(sourceCode, identifier);
        const checkProcessModulePromise = (node) => {
            const isUnsafe =
                isProcessModulePromise(sourceCode, node) &&
                !isSafeProcessModulePromiseUse(sourceCode, node);
            if (isUnsafe) {
                report(node);
            }
        };

        return {
            'Program:exit'() {
                for (const scope of sourceCode.scopeManager.scopes) {
                    for (const reference of scope.references) {
                        const isTypeOnly = reference.isValueReference === false;
                        if (reference.isRead() && !isTypeOnly) {
                            checkProcessExpression(reference.identifier);
                            checkProcessModulePromise(reference.identifier);
                        }
                    }
                }
            },
            MemberExpression(node) {
                const keyName = getKeyName(node, node.property);
                const isEnv = keyName === 'env' && isProcess(sourceCode, node.object);
                if (isEnv && !isSafeEnvUse(sourceCode, node)) {
                    const target = getEnvReportTarget(node);
                    report(target);
                }
                if (keyName === 'process' || keyName === 'default') {
                    checkProcessExpression(node);
                }
            },
            AwaitExpression(node) {
                checkProcessExpression(node);
            },
            ImportExpression(node) {
                checkProcessModulePromise(node);
            },
            ExportNamedDeclaration(node) {
                const declaration = node.declaration;
                if (node.exportKind === 'type' || declaration?.type !== 'VariableDeclaration') {
                    return;
                }
                for (const declarator of declaration.declarations) {
                    const variables = sourceCode.getDeclaredVariables(declarator);
                    const exportsProcess = variables.some((variable) =>
                        isProcessValue(variable.identifiers[0]),
                    );
                    if (exportsProcess) {
                        report(declarator);
                    }
                }
            },
            ExportAllDeclaration(node) {
                if (node.exportKind !== 'type' && isProcessModule(node.source)) {
                    report(node);
                }
            },
            ObjectPattern(node) {
                if (!isBoundToProcess(sourceCode, node)) {
                    return;
                }
                for (const property of node.properties) {
                    const copiesProcess = property.type === 'RestElement';
                    const isUnsafeEnv =
                        property.type === 'Property' &&
                        getKeyName(property, property.key) === 'env' &&
                        !isSafeEnvBinding(property.value);
                    if (copiesProcess || isUnsafeEnv) {
                        report(property);
                    }
                }
            },
            AssignmentExpression(node) {
                if (isGlobalProcessTarget(sourceCode, node.left)) {
                    report(node);
                }
            },
            CallExpression(node) {
                if (isReportedCall(sourceCode, node)) {
                    const chainEnd = getCallChainEnd(node);
                    report(chainEnd);
                }
                checkProcessExpression(node);
            },
            ImportSpecifier(node) {
                const isTypeOnly = node.importKind === 'type' || node.parent.importKind === 'type';
                const importsEnv =
                    !isTypeOnly &&
                    isProcessModule(node.parent.source) &&
                    node.imported.name === 'env';
                if (importsEnv) {
                    report(node);
                }
            },
            ExportSpecifier(node) {
                const declaration = node.parent;
                const isTypeOnly = node.exportKind === 'type' || declaration.exportKind === 'type';
                const reExportsEnv =
                    declaration.source &&
                    isProcessModule(declaration.source) &&
                    (node.local.name === 'env' || node.local.name === 'default');
                if (!isTypeOnly && reExportsEnv) {
                    report(node);
                }
            },
        };
    },
};
