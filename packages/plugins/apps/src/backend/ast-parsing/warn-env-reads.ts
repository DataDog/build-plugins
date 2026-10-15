// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type * as eslintScope from 'eslint-scope';
import type {
    ArrayExpression,
    ArrowFunctionExpression,
    AssignmentExpression,
    AssignmentPattern,
    BaseNode,
    CallExpression,
    Expression,
    ForOfStatement,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    ImportDeclaration,
    NewExpression,
    MemberExpression,
    ObjectExpression,
    ObjectPattern,
    Pattern,
    Program,
    Property,
    SpreadElement,
    Super,
    VariableDeclaration,
    VariableDeclarator,
} from 'estree';

import { describeRuntime } from '../../runtime-names';

import {
    resolveStaticPropertyName,
    staticMemberName,
    staticPropertyName,
    unwrapDefaultValue,
} from './ambient-global-access';
import { getModuleExportName, isImportCallee } from './module-graph';
import { hasSingleValue, reassignments, resolveIdentifier } from './module-scope';
import type { ModuleScopeAnalysis } from './module-scope';
import { ensureProgram, isStringLiteral, staticStringValue } from './type-guards';
import { walkAst } from './walk-ast';
import type { WalkAstVisitors } from './walk-ast';

export const WHOLE_ENV_USE = 'process.env';
// `process.env` inherits these, so a member with one of these names isn't a variable.
const OBJECT_PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);
const OBJECT_PROTOTYPE_KEYS = new Set(OBJECT_PROTOTYPE_NAMES);
const KEY_CHECK_METHODS = new Set(['hasOwnProperty', 'propertyIsEnumerable']);
const IDENTIFIER_KEY = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

// Every transform and local run re-checks a file, so each use is reported once per file; cleared wholesale once too large, to cap memory in long dev sessions.
export const MAX_TRACKED_FILES = 500;
const warnedUsesByFile = new Map<string, Set<string | symbol>>();

export const ENV_NOT_PASSED_EXPLANATION = `In production, the ${describeRuntime('v2')} doesn't pass your own environment variables or Custom Credentials to backend functions, so these reads won't see the values they see in local dev.`;

// Test-only escape hatch: clears the cross-call dedup cache between test cases that reuse the same file path.
export function resetEnvReadWarnings(): void {
    warnedUsesByFile.clear();
}

const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'global']);
const ROOT_NAMES = new Set(['process', ...GLOBAL_OBJECT_NAMES]);
const NO_VISITED: ReadonlySet<eslintScope.Variable> = new Set();

// What an expression holds on the way to `process.env`: the global object, the `process` module's
// namespace (whose `default` is `process`), `process`, or `process.env` itself.
type Role = 'global' | 'namespace' | 'process' | 'env';
const MEMBER_ROLES = new Map<Role, ReadonlyMap<string, Role>>([
    [
        'global',
        new Map<string, Role>([
            ['process', 'process'],
            ['globalThis', 'global'],
            ['global', 'global'],
        ]),
    ],
    [
        'namespace',
        new Map<string, Role>([
            ['default', 'process'],
            ['env', 'env'],
        ]),
    ],
    ['process', new Map<string, Role>([['env', 'env']])],
]);

function memberRole(role: Role | undefined, name: string | undefined): Role | undefined {
    return role === undefined || name === undefined ? undefined : MEMBER_ROLES.get(role)?.get(name);
}

// `Object`/`Reflect` statics taking env first and a key second: reads name the key, writes aren't reads.
const ENV_STATIC_CALLS = new Map<string, 'read' | 'write'>([
    ['Object.hasOwn', 'read'],
    ['Object.getOwnPropertyDescriptor', 'read'],
    ['Reflect.get', 'read'],
    ['Reflect.has', 'read'],
    ['Reflect.getOwnPropertyDescriptor', 'read'],
    ['Object.assign', 'write'],
    ['Object.defineProperty', 'write'],
    ['Object.defineProperties', 'write'],
    ['Reflect.set', 'write'],
    ['Reflect.defineProperty', 'write'],
    ['Reflect.deleteProperty', 'write'],
]);

// The Object writes hand back the object they write into; the Reflect ones return a boolean.
const TARGET_RETURNING_WRITES = new Set([
    'Object.assign',
    'Object.defineProperty',
    'Object.defineProperties',
]);

function importedRole(specifier: ImportDeclaration['specifiers'][number]): Role | undefined {
    if (specifier.type === 'ImportNamespaceSpecifier') {
        return 'namespace';
    }
    const importedName =
        specifier.type === 'ImportSpecifier' ? getModuleExportName(specifier.imported) : 'default';
    return memberRole('namespace', importedName);
}

function collectProcessImports(
    program: Program,
    scope: ModuleScopeAnalysis,
): Map<eslintScope.Variable, Role> {
    const imports = new Map<eslintScope.Variable, Role>();
    for (const node of program.body) {
        if (node.type !== 'ImportDeclaration' || !isStringLiteral(node.source)) {
            continue;
        }
        if (!PROCESS_MODULES.has(node.source.value)) {
            continue;
        }
        for (const specifier of node.specifiers) {
            const [variable] = scope.scopeManager.getDeclaredVariables(specifier);
            const role = importedRole(specifier);
            if (variable && role) {
                imports.set(variable, role);
            }
        }
    }
    return imports;
}

// `export { env }`, `export { default }` or `export *` from 'process' hands env to the importer.
function reexportsEnv(program: Program): boolean {
    return program.body.some((node) => {
        if (node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportAllDeclaration') {
            return false;
        }
        if (!isStringLiteral(node.source) || !PROCESS_MODULES.has(node.source.value)) {
            return false;
        }
        if (node.type === 'ExportAllDeclaration') {
            return true;
        }
        return node.specifiers.some((specifier) => {
            const localName = getModuleExportName(specifier.local);
            return localName === 'env' || localName === 'default';
        });
    });
}

// Rollup can also represent `import(x)` as a call whose callee is an `Import` node.
function dynamicImportSource(node: Expression): unknown {
    if (node.type === 'ImportExpression') {
        return node.source;
    }
    const isImportCall = node.type === 'CallExpression' && isImportCallee(node.callee);
    return isImportCall ? node.arguments[0] : undefined;
}

function isProcessImport(node: Expression): boolean {
    const source = dynamicImportSource(node);
    const specifier = staticStringValue(source);
    return specifier !== undefined && PROCESS_MODULES.has(specifier);
}

function importsProcessDynamically(program: Program): boolean {
    let found = false;
    const check = (node: Expression) => {
        found ||= isProcessImport(node);
    };
    walkAst(program, null, { ImportExpression: check, CallExpression: check });
    return found;
}

interface BindingSite {
    pattern: Pattern;
    sources: Expression[];
}

// What a binding holds: one of `sources`, read through each key of `path`, without the `omits`
// keys a rest element leaves out.
interface Binding {
    sources: Expression[];
    path: string[];
    omits?: ReadonlySet<string>;
}

interface EnvContext {
    scope: ModuleScopeAnalysis;
    imports: Map<eslintScope.Variable, Role>;
    bindings: Map<Identifier, Binding[]>;
    variableRoles: Map<eslintScope.Variable, Role | undefined>;
    // How many lookups a cycle back into the asking alias chain cut short so far.
    cycleCuts: number;
    // Lookups a cycle cut short, kept only for the outermost lookup still in progress.
    pendingRoles: Map<eslintScope.Variable, Role | undefined> | undefined;
    // Complete member lookups, so members built from members of other literals aren't re-walked.
    memberRoles: Map<MemberExpression, Role | undefined>;
    // Literal lookups through variables left, so literals that refer to each other stay linear.
    literalLookupsLeft: number;
    literalShapes: LiteralShapes;
}

// Per literal node, so repeated member lookups on a large literal don't rescan it.
interface LiteralShapes {
    objects: Map<ObjectExpression, { lastIndexByKey: Map<string, number>; lastSpread: number }>;
    arrays: Map<ArrayExpression, number>;
}

// A for-of binds each element of an inline array literal, so those elements are its only sources.
function forOfBinding(node: ForOfStatement): BindingSite | undefined {
    if (node.right.type !== 'ArrayExpression') {
        return undefined;
    }
    const sources = node.right.elements.filter(
        (element): element is Expression => element !== null && element.type !== 'SpreadElement',
    );
    if (node.left.type !== 'VariableDeclaration') {
        return { pattern: node.left, sources };
    }
    const [declarator, ...others] = node.left.declarations;
    return others.length === 0 ? { pattern: declarator.id, sources } : undefined;
}

type BindingNode = VariableDeclarator | AssignmentExpression | AssignmentPattern | ForOfStatement;

function bindingSite(node: BindingNode): BindingSite | undefined {
    switch (node.type) {
        case 'VariableDeclarator':
            return node.init ? { pattern: node.id, sources: [node.init] } : undefined;
        case 'AssignmentExpression':
            return node.operator === '='
                ? { pattern: node.left, sources: [node.right] }
                : undefined;
        // A default (`function run(p = process)`) is one value the binding can hold.
        case 'AssignmentPattern':
            return node.left.type === 'ObjectPattern' || node.left.type === 'Identifier'
                ? { pattern: node.left, sources: [node.right] }
                : undefined;
        case 'ForOfStatement':
            return forOfBinding(node);
    }
}

type InlineFunction = FunctionExpression | ArrowFunctionExpression;
type FunctionNode = FunctionDeclaration | InlineFunction;

function isInlineFunction(node: Expression | Super): node is InlineFunction {
    return node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

function variableOf(
    node: Expression | Super,
    scope: ModuleScopeAnalysis,
): eslintScope.Variable | undefined {
    return node.type === 'Identifier' ? resolveIdentifier(node, scope) : undefined;
}

function soleValue(
    variable: eslintScope.Variable | undefined,
    context: EnvContext,
): Expression | undefined {
    const [binding, ...otherBindings] = variable ? valueBindings(variable, context) : [];
    const [source, ...otherSources] = binding?.sources ?? [];
    const isOnlyValue =
        otherBindings.length === 0 && otherSources.length === 0 && binding?.path.length === 0;
    return isOnlyValue ? source : undefined;
}

function isProcessImportPromise(expression: Expression | Super, context: EnvContext): boolean {
    const node = unwrapChain(expression);
    const variable = variableOf(node, context.scope);
    const promise = node.type === 'Super' ? undefined : soleValue(variable, context) ?? node;
    return promise !== undefined && isProcessImport(promise);
}

function calledFunction(
    callee: Expression | Super,
    context: EnvContext,
    declarations: ReadonlyMap<Identifier, FunctionDeclaration>,
): FunctionNode | undefined {
    const node = unwrapChain(callee);
    if (isInlineFunction(node)) {
        return node;
    }
    const variable = variableOf(node, context.scope);
    const declared = variable?.defs.length === 1 && declarations.get(variable.defs[0].name);
    if (declared) {
        return hasSingleValue(variable) ? declared : undefined;
    }
    const source = soleValue(variable, context);
    return source && isInlineFunction(source) ? source : undefined;
}

function parameterSites(fn: FunctionNode, args: CallExpression['arguments']): BindingSite[] {
    const sites: BindingSite[] = [];
    for (const [index, param] of fn.params.entries()) {
        const arg = args[index];
        if (!arg || arg.type === 'SpreadElement') {
            break;
        }
        const pattern = param.type === 'AssignmentPattern' ? param.left : param;
        if (pattern.type === 'Identifier' || pattern.type === 'ObjectPattern') {
            sites.push({ pattern, sources: [arg] });
        }
    }
    return sites;
}

// A local function's parameters hold what its calls pass, and a then callback of
// `import('process')` gets the module's namespace, as awaiting the import would.
function callSites(
    node: CallExpression | NewExpression,
    context: EnvContext,
    declarations: ReadonlyMap<Identifier, FunctionDeclaration>,
): BindingSite[] {
    const { callee } = node;
    if (callee.type === 'MemberExpression' && staticMemberName(callee, context.scope) === 'then') {
        const imported = unwrapChain(callee.object);
        const [onFulfilled] = node.arguments;
        const isImport = imported.type !== 'Super' && isProcessImportPromise(imported, context);
        if (imported.type === 'Super' || !isImport || !onFulfilled) {
            return [];
        }
        const awaited: Expression = { type: 'AwaitExpression', argument: imported };
        const isCallback = onFulfilled.type !== 'SpreadElement' && isInlineFunction(onFulfilled);
        return isCallback ? parameterSites(onFulfilled, [awaited]) : [];
    }
    const fn = calledFunction(callee, context, declarations);
    return fn ? parameterSites(fn, node.arguments) : [];
}

interface CollectedBindings {
    bindings: Map<Identifier, Binding[]>;
    callSites: Map<CallExpression | NewExpression, BindingSite[]>;
}

// Each identifier a declaration, assignment, parameter default or for-of binds, mapped to what it
// binds, then what each call passes a local function's parameters. A rest element holds the rest
// of the same object, minus the static keys beside it.
function collectBindings(
    program: Program,
    scope: ModuleScopeAnalysis,
    imports: Map<eslintScope.Variable, Role>,
    literalShapes: LiteralShapes,
): CollectedBindings {
    const bindings = new Map<Identifier, Binding[]>();
    const addBindings = (pattern: Property['value'], binding: Binding) => {
        if (pattern.type === 'Identifier') {
            const known = bindings.get(pattern) ?? [];
            bindings.set(pattern, [...known, binding]);
            return;
        }
        if (pattern.type !== 'ObjectPattern') {
            return;
        }
        for (const property of pattern.properties) {
            if (property.type === 'RestElement') {
                const keysBeside = siblingKeys(pattern, scope);
                const omits = new Set(keysBeside);
                addBindings(property.argument, { ...binding, omits });
                continue;
            }
            const key = staticPropertyName(property, scope);
            const value = unwrapDefaultValue(property.value);
            if (key !== undefined) {
                const path = [...binding.path, key];
                addBindings(value, { ...binding, path });
            }
        }
    };
    const addSite = (node: BindingNode) => {
        const site = bindingSite(node);
        if (site) {
            addBindings(site.pattern, { sources: site.sources, path: [] });
        }
    };
    const declarations = new Map<Identifier, FunctionDeclaration>();
    walkAst(program, null, {
        VariableDeclarator: addSite,
        AssignmentExpression: addSite,
        AssignmentPattern: addSite,
        ForOfStatement: addSite,
        FunctionDeclaration(node) {
            if (node.id) {
                declarations.set(node.id, node);
            }
        },
    });
    // Calls resolve against the bindings above, and bind a parameter only to an argument with a role
    // there, so what a call binds doesn't depend on other calls or their order.
    const declared: EnvContext = {
        scope,
        imports,
        bindings: new Map(bindings),
        variableRoles: new Map(),
        cycleCuts: 0,
        pendingRoles: undefined,
        memberRoles: new Map(),
        literalLookupsLeft: MAX_LITERAL_LOOKUPS,
        literalShapes,
    };
    const sitesByCall = new Map<CallExpression | NewExpression, BindingSite[]>();
    const addCallSites = (node: CallExpression | NewExpression) => {
        const sites = callSites(node, declared, declarations).filter(({ sources }) =>
            sources.some((source) => roleOf(source, declared) !== undefined),
        );
        if (sites.length > 0) {
            sitesByCall.set(node, sites);
        }
        for (const site of sites) {
            addBindings(site.pattern, { sources: site.sources, path: [] });
        }
    };
    walkAst(program, null, { CallExpression: addCallSites, NewExpression: addCallSites });
    return { bindings, callSites: sitesByCall };
}

function siblingKeys(pattern: ObjectPattern, scope: ModuleScopeAnalysis): string[] {
    return pattern.properties.flatMap((property) => {
        const key = property.type === 'Property' ? staticPropertyName(property, scope) : undefined;
        return key === undefined ? [] : [key];
    });
}

// A rest binding has no member it left out, so `rest.env` after `{ env, ...rest }` reads nothing.
function omitsMember(object: Expression | Super, name: string, context: EnvContext): boolean {
    const node = unwrapChain(object);
    const variable = variableOf(node, context.scope);
    const bindings = variable === undefined ? [] : valueBindings(variable, context);
    return bindings.length > 0 && bindings.every(({ omits }) => omits?.has(name) === true);
}

// The bindings that give a variable its value: its declaration when nothing reassigns it, or its one assignment when it's declared without a value.
function valueBindings(variable: eslintScope.Variable, context: EnvContext): Binding[] {
    if (variable.defs.length !== 1) {
        return [];
    }
    const [definition] = variable.defs;
    const declared = context.bindings.get(definition.name);
    if (declared) {
        return hasSingleValue(variable) ? declared : [];
    }
    const writes = reassignments(variable);
    if (definition.type !== 'Variable' || writes.length !== 1) {
        return [];
    }
    const [{ identifier: assigned }] = writes;
    return context.bindings.get(assigned) ?? [];
}

function bindingRole(
    variable: eslintScope.Variable,
    context: EnvContext,
    visited: ReadonlySet<eslintScope.Variable>,
): Role | undefined {
    if (visited.has(variable)) {
        context.cycleCuts += 1;
        return undefined;
    }
    for (const { sources, path } of valueBindings(variable, context)) {
        for (const source of sources) {
            // A separate set per source, so one that fails through an alias doesn't hide it from the next.
            const sourceVisited = new Set([...visited, variable]);
            const role = roleThroughPath(source, path, context, sourceVisited);
            if (role) {
                return role;
            }
        }
    }
    return undefined;
}

function roleThroughPath(
    source: Expression | Super,
    path: string[],
    context: EnvContext,
    visited: ReadonlySet<eslintScope.Variable>,
): Role | undefined {
    let expression = source;
    let expressionVisited = visited;
    for (const [index, key] of path.entries()) {
        const member = literalMember(expression, key, context, expressionVisited);
        if (!member) {
            const role = roleOf(expression, context, expressionVisited);
            return path.slice(index).reduce(memberRole, role);
        }
        ({ expression, visited: expressionVisited } = member);
    }
    return roleOf(expression, context, expressionVisited);
}

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
const MAX_LITERAL_LOOKUPS = 20_000;
const PATTERN_TYPES = new Set([
    'ObjectPattern',
    'ArrayPattern',
    'RestElement',
    'AssignmentPattern',
]);

function isExpressionValue(value: Property['value']): value is Expression {
    return !PATTERN_TYPES.has(value.type);
}

function arrayIndexName({ computed, property }: MemberExpression): string | undefined {
    const isIndex =
        computed &&
        property.type === 'Literal' &&
        typeof property.value === 'number' &&
        Number.isInteger(property.value) &&
        property.value >= 0;
    return isIndex ? String(property.value) : undefined;
}

interface LiteralMember {
    expression: Expression;
    // The variables followed to reach it, so a literal that refers back to itself ends.
    visited: ReadonlySet<eslintScope.Variable>;
}

function objectShape(node: ObjectExpression, context: EnvContext) {
    let shape = context.literalShapes.objects.get(node);
    if (!shape) {
        const lastIndexByKey = new Map<string, number>();
        let lastSpread = -1;
        for (const [position, property] of node.properties.entries()) {
            const key =
                property.type === 'Property'
                    ? staticPropertyName(property, context.scope)
                    : undefined;
            if (key !== undefined) {
                lastIndexByKey.set(key, position);
            } else if (property.type === 'SpreadElement') {
                lastSpread = position;
            }
        }
        shape = { lastIndexByKey, lastSpread };
        context.literalShapes.objects.set(node, shape);
    }
    return shape;
}

function firstArraySpread(node: ArrayExpression, context: EnvContext): number {
    let firstSpread = context.literalShapes.arrays.get(node);
    if (firstSpread === undefined) {
        const position = node.elements.findIndex((element) => element?.type === 'SpreadElement');
        firstSpread = position === -1 ? Number.POSITIVE_INFINITY : position;
        context.literalShapes.arrays.set(node, firstSpread);
    }
    return firstSpread;
}

function literalMember(
    object: Expression | Super,
    name: string,
    context: EnvContext,
    visited: ReadonlySet<eslintScope.Variable>,
): LiteralMember | undefined {
    const node = unwrapChain(object);
    if (node.type === 'ObjectExpression') {
        const { lastIndexByKey, lastSpread } = objectShape(node, context);
        const index = lastIndexByKey.get(name) ?? -1;
        const property = node.properties[index];
        // A later spread can replace the property, so the spread's role decides instead.
        const isOverridden = lastSpread > index;
        const value = property?.type === 'Property' && !isOverridden ? property.value : undefined;
        return value && isExpressionValue(value) ? { expression: value, visited } : undefined;
    }
    if (node.type === 'ArrayExpression') {
        const index = ARRAY_INDEX.test(name) ? Number(name) : -1;
        const element = index === -1 ? undefined : node.elements[index];
        const isPositional = index < firstArraySpread(node, context);
        const isElement = isPositional && element && element.type !== 'SpreadElement';
        return isElement ? { expression: element, visited } : undefined;
    }
    const variable = variableOf(node, context.scope);
    if (variable && visited.has(variable)) {
        context.cycleCuts += 1;
        return undefined;
    }
    const source = soleValue(variable, context);
    // Spent budget is final, not a cut, so later lookups stay cached.
    if (!variable || !source || context.literalLookupsLeft <= 0) {
        return undefined;
    }
    context.literalLookupsLeft -= 1;
    const sourceVisited = new Set([...visited, variable]);
    return literalMember(source, name, context, sourceVisited);
}

function variableRole(
    variable: eslintScope.Variable,
    context: EnvContext,
    visited: ReadonlySet<eslintScope.Variable>,
): Role | undefined {
    const imported = context.imports.get(variable);
    if (imported) {
        return imported;
    }
    if (context.variableRoles.has(variable)) {
        return context.variableRoles.get(variable);
    }
    if (context.pendingRoles?.has(variable)) {
        // Reusing a cut-short lookup can miss a role too, so it counts as a cut.
        context.cycleCuts += 1;
        return context.pendingRoles.get(variable);
    }
    const isOutermost = context.pendingRoles === undefined;
    context.pendingRoles ??= new Map();
    const cutsBefore = context.cycleCuts;
    const role = bindingRole(variable, context, visited);
    // A lookup a cycle cut short can miss a role, so only a complete one is kept for good.
    const roles = context.cycleCuts === cutsBefore ? context.variableRoles : context.pendingRoles;
    roles.set(variable, role);
    if (isOutermost) {
        context.pendingRoles = undefined;
    }
    return role;
}

function identifierRole(
    node: Identifier,
    context: EnvContext,
    visited: ReadonlySet<eslintScope.Variable>,
): Role | undefined {
    const variable = resolveIdentifier(node, context.scope);
    if (variable) {
        return variableRole(variable, context, visited);
    }
    if (node.name === 'process') {
        return 'process';
    }
    return GLOBAL_OBJECT_NAMES.has(node.name) ? 'global' : undefined;
}

function roleOf(
    expression: Expression | Super,
    context: EnvContext,
    visited: ReadonlySet<eslintScope.Variable> = new Set(),
): Role | undefined {
    const node = unwrapChain(expression);
    switch (node.type) {
        case 'MemberExpression': {
            if (context.memberRoles.has(node)) {
                return context.memberRoles.get(node);
            }
            const cutsBefore = context.cycleCuts;
            const role = memberExpressionRole(node, context, visited);
            if (context.cycleCuts === cutsBefore) {
                context.memberRoles.set(node, role);
            }
            return role;
        }
        case 'SequenceExpression':
            return roleOf(node.expressions[node.expressions.length - 1], context, visited);
        // A spread copies the members, `process.env` among them, as an alias would hold them.
        case 'ObjectExpression':
            for (const property of [...node.properties].reverse()) {
                const role =
                    property.type === 'SpreadElement'
                        ? roleOf(property.argument, context, visited)
                        : undefined;
                if (role) {
                    return role;
                }
            }
            return undefined;
        case 'AwaitExpression':
            return isProcessImportPromise(node.argument, context) ? 'namespace' : undefined;
        case 'Identifier':
            return identifierRole(node, context, visited);
        // `a && b` is `b` whenever `a` is an object; with `??` or `||`, as in `globalThis.process ?? {}`, either side may be.
        case 'LogicalExpression':
            if (node.operator === '&&') {
                return roleOf(node.right, context, visited);
            }
            return roleOf(node.left, context, visited) ?? roleOf(node.right, context, visited);
        case 'AssignmentExpression':
            return node.operator === '=' ? roleOf(node.right, context, visited) : undefined;
        case 'ConditionalExpression':
            return (
                roleOf(node.consequent, context, visited) ??
                roleOf(node.alternate, context, visited)
            );
        case 'CallExpression': {
            const { callee } = node;
            const [target] = node.arguments;
            if (callee.type !== 'MemberExpression' || !target || target.type === 'SpreadElement') {
                return undefined;
            }
            const method = staticMemberName(callee, context.scope);
            const name =
                method === undefined ? undefined : staticCallName(callee, method, context.scope);
            const returnsTarget = name !== undefined && TARGET_RETURNING_WRITES.has(name);
            if (!returnsTarget) {
                return undefined;
            }
            const targetRole = roleOf(target, context, visited);
            // Object.assign also copies its sources' members into the target it returns.
            const copied = name === 'Object.assign' ? node.arguments.slice(1) : [];
            return copied.reduce<Role | undefined>(
                (role, source) =>
                    role ??
                    (source.type === 'SpreadElement'
                        ? undefined
                        : roleOf(source, context, visited)),
                targetRole,
            );
        }
        default:
            return undefined;
    }
}

function memberExpressionRole(
    node: MemberExpression,
    context: EnvContext,
    visited: ReadonlySet<eslintScope.Variable>,
): Role | undefined {
    const name = staticMemberName(node, context.scope);
    if (name !== undefined && omitsMember(node.object, name, context)) {
        return undefined;
    }
    const memberName = name ?? arrayIndexName(node);
    const member =
        memberName === undefined
            ? undefined
            : literalMember(node.object, memberName, context, visited);
    if (member) {
        return roleOf(member.expression, context, member.visited);
    }
    const objectRole = roleOf(node.object, context, visited);
    return memberRole(objectRole, name);
}

function isUnresolvedGlobal(node: Expression | Super, scope: ModuleScopeAnalysis): boolean {
    return node.type === 'Identifier' && !resolveIdentifier(node, scope);
}

function staticCallName(
    callee: MemberExpression,
    method: string,
    scope: ModuleScopeAnalysis,
): string | undefined {
    const owner = unwrapChain(callee.object);
    if (owner.type !== 'Identifier' || !isUnresolvedGlobal(owner, scope)) {
        return undefined;
    }
    return `${owner.name}.${method}`;
}

function envStaticCall(
    callee: MemberExpression,
    method: string,
    scope: ModuleScopeAnalysis,
): 'read' | 'write' | undefined {
    const name = staticCallName(callee, method, scope);
    return name === undefined ? undefined : ENV_STATIC_CALLS.get(name);
}

function isPrototypeKeyCheck(expression: Expression | Super, scope: ModuleScopeAnalysis): boolean {
    const node = unwrapChain(expression);
    if (node.type !== 'MemberExpression') {
        return false;
    }
    const method = staticMemberName(node, scope);
    const owner = unwrapChain(node.object);
    if (method === undefined || !KEY_CHECK_METHODS.has(method)) {
        return false;
    }
    if (owner.type !== 'MemberExpression' || staticMemberName(owner, scope) !== 'prototype') {
        return false;
    }
    const ownerObject = owner.object;
    return (
        ownerObject.type === 'Identifier' &&
        ownerObject.name === 'Object' &&
        isUnresolvedGlobal(ownerObject, scope)
    );
}

function unwrapChain(node: Expression | Super): Expression | Super {
    return node.type === 'ChainExpression' ? node.expression : node;
}

function envUse(key: string): string {
    return IDENTIFIER_KEY.test(key) ? `process.env.${key}` : `process.env[${JSON.stringify(key)}]`;
}

// The static keys a destructure reads, and whether it also reads ones it can't name: a computed key
// or an inherited member. A rest element is bound to the rest of env, so its own uses are followed.
function destructuredKeys(
    pattern: ObjectPattern,
    scope: ModuleScopeAnalysis,
): { keys: string[]; readsUnnamedKeys: boolean } {
    const keys: string[] = [];
    let readsUnnamedKeys = false;
    for (const property of pattern.properties) {
        if (property.type === 'RestElement') {
            continue;
        }
        const key = staticPropertyName(property, scope);
        if (key === undefined || OBJECT_PROTOTYPE_KEYS.has(key)) {
            readsUnnamedKeys = true;
        } else {
            keys.push(key);
        }
    }
    return { keys, readsUnnamedKeys };
}

// Without a `process` or global object reference, or a `process` import, nothing reaches `process.env`.
function mayReachEnv(
    program: Program,
    scope: ModuleScopeAnalysis,
    imports: ReadonlyMap<eslintScope.Variable, Role>,
): boolean {
    if (imports.size > 0) {
        return true;
    }
    for (const [identifier, reference] of scope.referencesByIdentifier) {
        if (!reference.resolved && ROOT_NAMES.has(identifier.name)) {
            return true;
        }
    }
    return importsProcessDynamically(program);
}

// Warns (never rejects) on `process.env` under v2, where production doesn't pass the developer's variables or Custom Credentials.
export function warnAboutEnvReads(
    ast: BaseNode,
    filePath: string,
    log: Logger,
    scopeAnalysis: ModuleScopeAnalysis,
): void {
    const program = ensureProgram(ast, filePath);
    const uses = new Set<string>();
    if (reexportsEnv(program)) {
        uses.add(WHOLE_ENV_USE);
    }
    const imports = collectProcessImports(program, scopeAnalysis);
    if (!mayReachEnv(program, scopeAnalysis, imports)) {
        reportNewUses(uses, filePath, log);
        return;
    }
    const literalShapes: LiteralShapes = { objects: new Map(), arrays: new Map() };
    // Filled in inside the try below, which also guards collecting them.
    let sitesByCall: ReadonlyMap<CallExpression | NewExpression, BindingSite[]> = new Map();
    const context: EnvContext = {
        scope: scopeAnalysis,
        imports,
        bindings: new Map(),
        variableRoles: new Map(),
        cycleCuts: 0,
        pendingRoles: undefined,
        memberRoles: new Map(),
        literalLookupsLeft: MAX_LITERAL_LOOKUPS,
        literalShapes,
    };
    // `walkAst` visits parents first, so a key read or write marks its `env` object here before the object itself is visited.
    const accountedEnvNodes = new Set<Expression | Super>();
    const writtenTargets = new Set<MemberExpression>();
    const keyCheckCallees = new Set<MemberExpression>();
    // Each member object is asked about again as a member itself.
    const roles = new Map<Expression | Super, Role | undefined>();
    const envRole = (node: Expression | Super): Role | undefined => {
        if (!roles.has(node)) {
            const role = roleOf(node, context);
            roles.set(node, role);
        }
        return roles.get(node);
    };
    const isEnv = (node: Expression | Super) => envRole(node) === 'env';

    const addKeyUse = (key: string) => {
        const use = envUse(key);
        uses.add(use);
    };
    // Marks each `env` a key read or write uses, through the fallbacks roleOf looks through.
    const markAccounted = (envNode: Expression | Super) => {
        const node = unwrapChain(envNode);
        if (node.type === 'LogicalExpression') {
            if (node.operator !== '&&') {
                markAccounted(node.left);
            }
            markAccounted(node.right);
        } else if (node.type === 'ConditionalExpression') {
            markAccounted(node.consequent);
            markAccounted(node.alternate);
        } else if (node.type === 'SequenceExpression') {
            markAccounted(node.expressions[node.expressions.length - 1]);
        } else if (node.type === 'AssignmentExpression') {
            if (node.operator === '=' && bindsEnvFully(node.left)) {
                markAccounted(node.right);
            }
        } else if (isEnv(node)) {
            accountedEnvNodes.add(node);
        }
    };
    const addKeyCheck = (
        envNode: Expression | Super,
        keyNode: Expression | SpreadElement | undefined,
    ): boolean => {
        const object = unwrapChain(envNode);
        const isKeyExpression = keyNode !== undefined && keyNode.type !== 'SpreadElement';
        const key = isKeyExpression ? resolveStaticPropertyName(keyNode, scopeAnalysis) : undefined;
        if (key === undefined || !isEnv(object)) {
            return false;
        }
        markAccounted(object);
        addKeyUse(key);
        return true;
    };
    // Testing whether env exists reads none of its variables.
    const markGuard = (test: Expression) => {
        const node = unwrapChain(test);
        if (node.type === 'LogicalExpression' && node.operator === '&&') {
            markGuard(node.left);
            markGuard(node.right);
        } else if (isEnv(node)) {
            accountedEnvNodes.add(node);
        }
    };
    const readsEnvKey = (expression: Expression) => {
        const node = unwrapChain(expression);
        if (node.type !== 'MemberExpression') {
            return false;
        }
        const object = unwrapChain(node.object);
        return isEnv(object);
    };
    const markWritten = (envNode: Expression) => {
        if (isEnv(envNode)) {
            markAccounted(envNode);
        }
    };
    const addWriteTargets = (target: Pattern) => {
        switch (target.type) {
            case 'MemberExpression':
                writtenTargets.add(target);
                return;
            case 'ObjectPattern':
                for (const property of target.properties) {
                    addWriteTargets(property.type === 'Property' ? property.value : property);
                }
                return;
            case 'ArrayPattern':
                for (const element of target.elements) {
                    if (element) {
                        addWriteTargets(element);
                    }
                }
                return;
            case 'RestElement':
                addWriteTargets(target.argument);
                return;
            case 'AssignmentPattern':
                addWriteTargets(target.left);
        }
    };
    // `source` lets a destructure follow the members of an object literal wrapping process.
    const checkPattern = (
        pattern: Property['value'],
        role: Role | undefined,
        source?: Expression,
    ) => {
        if ((role === undefined && source === undefined) || pattern.type !== 'ObjectPattern') {
            return;
        }
        if (role === 'env') {
            const { keys, readsUnnamedKeys } = destructuredKeys(pattern, scopeAnalysis);
            keys.forEach(addKeyUse);
            if (readsUnnamedKeys) {
                uses.add(WHOLE_ENV_USE);
            }
            return;
        }
        for (const property of pattern.properties) {
            if (property.type === 'Property') {
                const key = staticPropertyName(property, scopeAnalysis);
                const value = unwrapDefaultValue(property.value);
                const member =
                    source && key !== undefined
                        ? literalMember(source, key, context, NO_VISITED)
                        : undefined;
                const valueRole = member ? envRole(member.expression) : memberRole(role, key);
                checkPattern(value, valueRole, member?.expression);
            }
        }
    };
    // An alias of env whose own uses are followed doesn't use env whole by being bound.
    const bindsEnvFully = (pattern: Pattern) =>
        pattern.type === 'ObjectPattern' || (pattern.type === 'Identifier' && isEnv(pattern));
    // An assignment or env-returning write used as a value passes env on too, so only one whose
    // value is discarded binds it fully.
    const statementAssignments = new Set<AssignmentExpression>();
    const statementCalls = new Set<CallExpression>();
    const addDiscarded = (expression: Expression | VariableDeclaration | null | undefined) => {
        switch (expression?.type) {
            case 'AssignmentExpression':
                statementAssignments.add(expression);
                return;
            case 'CallExpression':
                statementCalls.add(expression);
                return;
            case 'ChainExpression':
                addDiscarded(expression.expression);
                return;
            case 'AwaitExpression':
                addDiscarded(expression.argument);
                return;
            case 'UnaryExpression':
                if (expression.operator === 'void') {
                    addDiscarded(expression.argument);
                }
                return;
            // Neither operand's value leaves an expression whose own value is discarded.
            case 'LogicalExpression':
                addDiscarded(expression.left);
                addDiscarded(expression.right);
                return;
            case 'ConditionalExpression':
                addDiscarded(expression.consequent);
                addDiscarded(expression.alternate);
                return;
            case 'SequenceExpression':
                expression.expressions.forEach(addDiscarded);
        }
    };
    const checkBinding = (site: BindingSite, isUsedValue: boolean) => {
        for (const source of site.sources) {
            const role = envRole(source);
            if (role === 'env' && !isUsedValue && bindsEnvFully(site.pattern)) {
                markAccounted(source);
            }
            checkPattern(site.pattern, role, source);
        }
    };
    const checkSite = (node: BindingNode) => {
        const site = bindingSite(node);
        const isUsedValue = node.type === 'AssignmentExpression' && !statementAssignments.has(node);
        if (site) {
            checkBinding(site, isUsedValue);
        }
    };

    const visitors: WalkAstVisitors<Program, null> = {
        ExpressionStatement(node) {
            addDiscarded(node.expression);
        },
        SequenceExpression(node) {
            node.expressions.slice(0, -1).forEach(addDiscarded);
        },
        ForStatement(node) {
            addDiscarded(node.init);
            addDiscarded(node.update);
        },
        AssignmentExpression(node) {
            if (node.operator === '=') {
                addWriteTargets(node.left);
            }
            checkSite(node);
        },
        AssignmentPattern(node) {
            checkSite(node);
        },
        ForOfStatement(node) {
            if (node.left.type !== 'VariableDeclaration') {
                addWriteTargets(node.left);
            }
            checkSite(node);
        },
        ForInStatement(node) {
            if (node.left.type !== 'VariableDeclaration') {
                addWriteTargets(node.left);
            }
        },
        // Another module can read any key of an exported env, or of env through an exported process.
        // An exported global object isn't counted, since it's a common way to reach other globals.
        ExportNamedDeclaration(node) {
            const declared =
                node.declaration?.type === 'VariableDeclaration'
                    ? scopeAnalysis.scopeManager.getDeclaredVariables(node.declaration)
                    : [];
            const locals = node.source
                ? []
                : node.specifiers.flatMap(({ local }) => {
                      const variable =
                          local.type === 'Identifier'
                              ? resolveIdentifier(local, scopeAnalysis)
                              : undefined;
                      return variable ? [variable] : [];
                  });
            const exportsEnv = [...declared, ...locals].some((variable) => {
                const role = variableRole(variable, context, NO_VISITED);
                return role !== undefined && role !== 'global';
            });
            if (exportsEnv) {
                uses.add(WHOLE_ENV_USE);
            }
        },
        ExportDefaultDeclaration(node) {
            const { declaration } = node;
            const isExpression =
                declaration.type !== 'FunctionDeclaration' &&
                declaration.type !== 'ClassDeclaration';
            const role = isExpression ? envRole(declaration) : undefined;
            if (role !== undefined && role !== 'global') {
                uses.add(WHOLE_ENV_USE);
            }
        },
        UnaryExpression(node) {
            const target = unwrapChain(node.argument);
            if (node.operator === 'delete' && target.type === 'MemberExpression') {
                writtenTargets.add(target);
            }
            if (node.operator === '!' || node.operator === 'typeof') {
                markGuard(node.argument);
            }
        },
        // `env && env.KEY` guards the key read; `env && other` can still hand back env itself.
        LogicalExpression(node) {
            if (node.operator === '&&' && readsEnvKey(node.right)) {
                markGuard(node.left);
            }
        },
        ConditionalExpression(node) {
            markGuard(node.test);
        },
        IfStatement(node) {
            markGuard(node.test);
        },
        VariableDeclarator(node) {
            checkSite(node);
        },
        BinaryExpression(node) {
            if (node.operator === 'in' && node.left.type !== 'PrivateIdentifier') {
                addKeyCheck(node.right, node.left);
            }
        },
        NewExpression(node) {
            for (const site of sitesByCall.get(node) ?? []) {
                checkBinding(site, false);
            }
        },
        CallExpression(node) {
            for (const site of sitesByCall.get(node) ?? []) {
                checkBinding(site, false);
            }
            const { callee } = node;
            const method =
                callee.type === 'MemberExpression'
                    ? staticMemberName(callee, scopeAnalysis)
                    : undefined;
            if (callee.type !== 'MemberExpression' || method === undefined) {
                return;
            }
            const [first, second] = node.arguments;
            if (KEY_CHECK_METHODS.has(method) && addKeyCheck(callee.object, first)) {
                keyCheckCallees.add(callee);
            }
            if (!first || first.type === 'SpreadElement') {
                return;
            }
            const staticCall = envStaticCall(callee, method, scopeAnalysis);
            if (staticCall === 'read') {
                addKeyCheck(first, second);
            } else if (staticCall === 'write') {
                markWritten(first);
                const passesEnvOn = !statementCalls.has(node) && !accountedEnvNodes.has(node);
                if (passesEnvOn && isEnv(node)) {
                    uses.add(WHOLE_ENV_USE);
                }
            } else if (method === 'call' && isPrototypeKeyCheck(callee.object, scopeAnalysis)) {
                addKeyCheck(first, second);
            }
        },
        MemberExpression(node) {
            const object = unwrapChain(node.object);
            if (isEnv(object)) {
                const key = staticMemberName(node, scopeAnalysis);
                const isWritten = writtenTargets.has(node);
                const isVariableKey = key !== undefined && !OBJECT_PROTOTYPE_KEYS.has(key);
                if (isVariableKey || isWritten || keyCheckCallees.has(node)) {
                    markAccounted(object);
                }
                if (isVariableKey && !isWritten) {
                    addKeyUse(key);
                }
            }
            const isWholeEnv = !accountedEnvNodes.has(node) && !writtenTargets.has(node);
            if (isWholeEnv && isEnv(node)) {
                uses.add(WHOLE_ENV_USE);
            }
        },
        Identifier(node) {
            const isRead = scopeAnalysis.referencesByIdentifier.get(node)?.isRead() ?? false;
            if (isRead && !accountedEnvNodes.has(node) && isEnv(node)) {
                uses.add(WHOLE_ENV_USE);
            }
        },
    };
    try {
        const collected = collectBindings(program, scopeAnalysis, imports, literalShapes);
        context.bindings = collected.bindings;
        sitesByCall = collected.callSites;
        walkAst(program, null, visitors);
    } catch (error) {
        // A warning-only check must not fail the build, such as on an alias chain too deep for the call stack.
        reportNewUses(uses, filePath, log);
        const warned = warnedUsesFor(filePath);
        if (!warned.has(CHECK_FAILED)) {
            warned.add(CHECK_FAILED);
            const reason = error instanceof Error ? error.message : String(error);
            log.warn(`Could not check ${filePath} for process.env reads: ${reason}`);
        }
        return;
    }

    reportNewUses(uses, filePath, log);
}

// Marks a file whose check already failed, alongside the uses already reported for it.
const CHECK_FAILED = Symbol('check failed');

function warnedUsesFor(filePath: string): Set<string | symbol> {
    let warned = warnedUsesByFile.get(filePath);
    if (!warned) {
        if (warnedUsesByFile.size >= MAX_TRACKED_FILES) {
            warnedUsesByFile.clear();
        }
        warned = new Set<string | symbol>();
        warnedUsesByFile.set(filePath, warned);
    }
    return warned;
}

function reportNewUses(uses: ReadonlySet<string>, filePath: string, log: Logger): void {
    if (uses.size === 0) {
        return;
    }
    const warned = warnedUsesFor(filePath);

    const newUses = [...uses].filter((use) => !warned.has(use));
    if (newUses.length === 0) {
        return;
    }
    for (const use of newUses) {
        warned.add(use);
    }

    const useList = newUses.join(', ');
    log.warn(`${filePath} uses ${useList}. ${ENV_NOT_PASSED_EXPLANATION}`);
}
