// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Test runs start with CI secrets in their env, so a whole-env copy can carry any the setup scrub
// misses into failure output.
const MESSAGE =
    "Don't use process.env as a whole value in tests (reassign, replace, alias, spread, pass, or assert on it, or copy process itself). Read, set, or delete single keys, check for one with `'KEY' in process.env`, list names with Object.keys(process.env), reset Datadog keys with clearDatadogEnv() from @dd/tests/_jest/helpers/datadogEnv, and give child processes an env built from only the keys they need.";

const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['global', 'globalThis']);
const TYPE_WRAPPERS = new Set([
    'ChainExpression',
    'TSAsExpression',
    'TSNonNullExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
]);
// Calls that, given process.env first, only read names or touch the keys they're given.
const KEYED_ENV_CALLS = new Set([
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
// Like KEYED_ENV_CALLS, but they return process.env itself, so only a discarded result is safe.
const ENV_RETURNING_CALLS = new Set([
    'Object.assign',
    'Object.defineProperty',
    'Object.defineProperties',
]);
// Calls that only check for the env key when given (process, 'env').
const EXISTENCE_CHECKS = new Set(['Object.hasOwn', 'Reflect.has']);
// Calls that copy or print every property of an object they're given.
const WHOLE_VALUE_READERS = new Set([
    'JSON.stringify',
    'Object.entries',
    'Object.getOwnPropertyDescriptors',
    'Object.values',
    'structuredClone',
    'expect',
    'inspect',
    'util.inspect',
]);
// Calls that replace properties of their first argument from an object literal.
const PROPERTY_REPLACERS = new Set(['Object.assign', 'Object.defineProperties']);
const REQUIRE_CALLS = new Set(['require', 'jest.requireActual', 'jest.requireMock']);
// Jest ignores what these return from a callback without a `done` parameter. Tests and `done`
// callbacks print a returned value in their failure message.
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
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

const isConsoleCall = (callee) =>
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'console';

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
    if (seen.has(variable)) {
        return false;
    }
    seen.add(variable);
    return getBindings(variable).some((binding) =>
        isBoundFrom(
            sourceCode,
            binding,
            (source) => isGlobalObject(sourceCode, source, seen),
            false,
        ),
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

// Whether the value bound at a binding position (an identifier or a pattern) comes whole from a
// source that `matchesSource` accepts: a declarator, assignment, or default, walking out of
// defaults. Loop variables and other destructured keys get only part of a value, so they don't
// count. With `followsProcessKeys`, two keys whose value is process itself do: `process` on a
// pattern bound to the global object, and `default` on a pattern bound to process.
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
            return false;
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

// Results per variable, filled only by top-level lookups so a cycle cut short can't be cached.
const processVariables = new WeakMap();

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
            if (processVariables.has(variable)) {
                return processVariables.get(variable);
            }
            if (seen.has(variable)) {
                return false;
            }
            const isTopLevel = seen.size === 0;
            seen.add(variable);
            const isImported = variable.defs.some(
                (definition) => definition.type === 'ImportBinding' && isProcessImport(definition),
            );
            const result =
                isImported ||
                getBindings(variable).some((binding) =>
                    isBoundToProcess(sourceCode, binding, seen),
                );
            if (isTopLevel) {
                processVariables.set(variable, result);
            }
            return result;
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
            return (
                isProcess(sourceCode, target.left, seen) ||
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
            return (isRequire && isProcessModule(first)) || readsGlobalProcess;
        }
        case 'AwaitExpression': {
            const isImport = target.argument.type === 'ImportExpression';
            return isImport && isProcessModule(target.argument.source);
        }
        default:
            return false;
    }
};

// An object pattern that binds only named keys, never a rest copy of the whole object.
const isNamedKeyPattern = (node) =>
    node.type === 'ObjectPattern' &&
    node.properties.every((property) => property.type !== 'RestElement');

const FUNCTION_TYPES = new Set([
    'ArrowFunctionExpression',
    'FunctionDeclaration',
    'FunctionExpression',
]);

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

const isSafeEnvCall = (sourceCode, call, envArgument) => {
    if (call.arguments[0] !== envArgument) {
        return false;
    }
    const calleeName = getCalleeName(call.callee);
    if (KEYED_ENV_CALLS.has(calleeName) || isHasOwnPropertyCall(call.callee)) {
        return true;
    }
    return ENV_RETURNING_CALLS.has(calleeName) && isValueDiscarded(sourceCode, call);
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
            return isSafeEnvCall(sourceCode, parent, child);
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

// A destructured `env` value that binds only named keys, with or without a default.
const isSafeEnvBinding = (value) =>
    isNamedKeyPattern(value) ||
    (value.type === 'AssignmentPattern' && isNamedKeyPattern(value.left));

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
        const report = (node) => {
            context.report({ node, messageId: 'wholeProcessEnv' });
        };

        return {
            MemberExpression(node) {
                const isEnv =
                    getKeyName(node, node.property) === 'env' && isProcess(sourceCode, node.object);
                if (isEnv && !isSafeEnvUse(sourceCode, node)) {
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
            SpreadElement(node) {
                if (isProcess(sourceCode, node.argument)) {
                    report(node);
                }
            },
            CallExpression(node) {
                const calleeName = getCalleeName(node.callee);
                const [target, key] = node.arguments;
                const keyName = getStaticString(key);
                const sources = node.arguments.slice(1);
                const targetIsProcess = target !== undefined && isProcess(sourceCode, target);
                const checksExistence =
                    EXISTENCE_CHECKS.has(calleeName) || isHasOwnPropertyCall(node.callee);
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
                const copiesProcess =
                    calleeName === 'Object.assign' &&
                    sources.some((source) => isProcess(sourceCode, source));
                const readsWholeProcess =
                    (WHOLE_VALUE_READERS.has(calleeName) || isConsoleCall(node.callee)) &&
                    node.arguments.some((argument) => isProcess(sourceCode, argument));
                if (
                    replacesOrReadsEnv ||
                    replacesEnvFromLiteral ||
                    replacesGlobalProcess ||
                    replacesGlobalProcessFromLiteral ||
                    copiesProcess ||
                    readsWholeProcess
                ) {
                    report(node);
                }
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
                    !isTypeOnly &&
                    declaration.source &&
                    isProcessModule(declaration.source) &&
                    node.local.name === 'env';
                if (reExportsEnv) {
                    report(node);
                }
            },
        };
    },
};
