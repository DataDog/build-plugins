// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type {
    BaseNode,
    ExportAllDeclaration,
    ExportNamedDeclaration,
    Expression,
    Identifier,
    ImportExpression,
    Literal,
    ModuleDeclaration,
    Pattern,
    Program,
    SimpleCallExpression,
    VariableDeclaration,
} from 'estree';

import { importsBackendFunctionPackage, isBackendSourceModule } from '../backend-sources';

import { staticMemberName } from './ambient-global-access';
import {
    analyzeModuleScope,
    getModuleVariable,
    isImportVariable,
    type ModuleScopeAnalysis,
    resolveIdentifier,
} from './module-scope';
import { ensureProgram, isNodeOfType, isStringLiteral } from './type-guards';
import { walkAst } from './walk-ast';

/**
 * Parsed backend source module (app code or an opted-in package's code) plus reusable static facts about its module
 * boundary and top-level declarations. These facts are intentionally
 * domain-neutral: action-catalog and connection ID logic consume them later,
 * but they are not encoded into the record itself.
 */
export interface ParsedModuleRecord {
    id: string;
    ast: Program;
    scopeAnalysis: ModuleScopeAnalysis;
    staticDependencies: StaticModuleDependency[];
    unsupportedDependencies: ModuleDependency[];
    importsByVariable: Map<eslintScope.Variable, ImportBinding>;
    /**
     * Export names that can be answered directly by this module. Bare
     * `export *` edges stay in `starExports` because they must be probed by
     * requested export name during resolution.
     */
    exportsByName: Map<string, ExportBinding>;
    starExports: StarExport[];
    topLevelBindingsByVariable: Map<eslintScope.Variable, StaticBinding>;
}

export interface StaticModuleDependency {
    source: string;
    resolvedId: string;
}

export interface ModuleDependency {
    specifier: string;
    kind: 'dynamic-import' | 'require';
}

/**
 * Import binding keyed by the local eslint-scope variable, not the local text
 * name, so later lookups remain safe when names are shadowed.
 */
export type ImportBinding = NamedImportBinding | DefaultImportBinding | NamespaceImportBinding;

export interface NamedImportBinding {
    kind: 'named';
    importedName: string;
    resolvedId: string;
}

export interface DefaultImportBinding {
    kind: 'default';
    resolvedId: string;
}

export interface NamespaceImportBinding {
    kind: 'namespace';
    resolvedId: string;
}

/**
 * Export binding for names this module can answer without probing star
 * exports. Unsupported records preserve the fact that an export name exists
 * even when later static definition resolution will reject its form.
 */
export type ExportBinding = LocalExportBinding | ReExportBinding | UnsupportedExportBinding;

export interface LocalExportBinding {
    kind: 'local';
    variable: eslintScope.Variable;
}

export interface ReExportBinding {
    kind: 're-export';
    importedName: string;
    resolvedId: string;
}

export interface UnsupportedExportBinding {
    kind: 'unsupported';
    reason: string;
    resolvedId?: string;
}

export interface StarExport {
    resolvedId: string;
}

/**
 * Top-level declaration summary. This records whether a local variable has a
 * static expression later resolvers can inspect, without deciding whether that
 * expression is meaningful for any particular domain.
 */
export type StaticBinding = ConstStaticBinding | MutableStaticBinding | UnsupportedStaticBinding;

export interface ConstStaticBinding {
    kind: 'const';
    expression: Expression | null;
}

export interface MutableStaticBinding {
    kind: 'mutable';
    declarationKind: Exclude<VariableDeclaration['kind'], 'const'>;
}

export interface UnsupportedStaticBinding {
    kind: 'unsupported';
    reason: string;
}

type ImportCallExpression = SimpleCallExpression & { callee: { type: 'Import' } };
type ModuleExportName = Identifier | Literal;

/**
 * Creates the per-module analysis record consumed by backend-entry reachability
 * analysis. The caller supplies canonical module IDs and each static
 * import/export source's resolved ID (see `resolveStaticModuleSources`) instead
 * of asking this module to resolve/load files; a source with no resolved ID
 * fails closed.
 *
 * Returns null when the module is outside the analyzable backend source graph
 * (see `isBackendSourceModule`), allowing build collectors to skip ordinary
 * package/generated modules without duplicating graph filtering rules.
 */
export function createParsedModuleRecord(
    moduleId: string,
    buildRoot: string,
    ast: BaseNode,
    staticDependencies: StaticModuleDependency[],
): ParsedModuleRecord | null {
    if (!isBackendSourceModule(moduleId, buildRoot)) {
        return null;
    }

    const program = ensureProgram(ast, moduleId);
    const scopeAnalysis = analyzeModuleScope(program);
    const staticSourceList = getStaticModuleSources(program);
    const staticSources = new Set(staticSourceList);
    const resolvedIdBySource = new Map<string, string>();
    for (const { source, resolvedId } of staticDependencies) {
        if (!staticSources.has(source) || resolvedIdBySource.has(source)) {
            throw unsupportedModuleGraphDependency(
                moduleId,
                `resolved ID for "${source}", which isn't a distinct static import/export source,`,
            );
        }
        resolvedIdBySource.set(source, resolvedId);
    }
    const resolveSource = (source: string): string => {
        const resolvedId = resolvedIdBySource.get(source);
        if (resolvedId === undefined) {
            throw unsupportedModuleGraphDependency(
                moduleId,
                `static import/export source "${source}" with no resolved ID`,
            );
        }
        return resolvedId;
    };

    return {
        id: moduleId,
        ast: program,
        scopeAnalysis,
        staticDependencies,
        unsupportedDependencies: collectUnsupportedModuleDependencies(program, moduleId, buildRoot),
        importsByVariable: collectImportBindings(program, scopeAnalysis, resolveSource),
        exportsByName: collectExportBindings(program, scopeAnalysis, resolveSource),
        starExports: collectStarExports(program, resolveSource),
        topLevelBindingsByVariable: collectTopLevelBindings(program, scopeAnalysis),
    };
}

/**
 * Resolves each distinct static import/export source once, into the
 * source/ID pairs `createParsedModuleRecord` expects; a source `resolve` can't
 * resolve (null) fails closed. Bundler-reported import lists can't stand in
 * for this: Rolldown dedupes them by resolved ID, so they can't be paired with
 * the AST's sources.
 */
export async function resolveStaticModuleSources(
    ast: Program,
    moduleId: string,
    resolve: (source: string) => Promise<string | null>,
): Promise<StaticModuleDependency[]> {
    const staticModuleSources = getStaticModuleSources(ast);
    const distinctSources = [...new Set(staticModuleSources)];
    const resolutions = distinctSources.map(async (source) => {
        const resolvedId = await resolve(source);
        if (resolvedId === null) {
            throw unsupportedModuleGraphDependency(
                moduleId,
                `unresolvable import specifier "${source}"`,
            );
        }
        return { source, resolvedId };
    });
    return Promise.all(resolutions);
}

export function getStaticModuleSources(ast: Program): string[] {
    return ast.body.flatMap((node) => {
        if (
            (node.type === 'ImportDeclaration' ||
                node.type === 'ExportNamedDeclaration' ||
                node.type === 'ExportAllDeclaration') &&
            node.source &&
            isStringLiteral(node.source)
        ) {
            return [node.source.value];
        }

        return [];
    });
}

function collectImportBindings(
    ast: Program,
    scopeAnalysis: ModuleScopeAnalysis,
    resolveSource: (source: string) => string,
): Map<eslintScope.Variable, ImportBinding> {
    const importsByVariable = new Map<eslintScope.Variable, ImportBinding>();

    for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration' || !isStringLiteral(node.source)) {
            continue;
        }

        const resolvedId = resolveSource(node.source.value);
        for (const specifier of node.specifiers) {
            const [variable] = scopeAnalysis.scopeManager.getDeclaredVariables(specifier);
            if (!variable) {
                continue;
            }

            if (specifier.type === 'ImportSpecifier') {
                importsByVariable.set(variable, {
                    kind: 'named',
                    importedName: getModuleExportName(specifier.imported),
                    resolvedId,
                });
                continue;
            }

            importsByVariable.set(variable, {
                kind: specifier.type === 'ImportDefaultSpecifier' ? 'default' : 'namespace',
                resolvedId,
            });
        }
    }

    return importsByVariable;
}

function collectExportBindings(
    ast: Program,
    scopeAnalysis: ModuleScopeAnalysis,
    resolveSource: (source: string) => string,
): Map<string, ExportBinding> {
    const exportsByName = new Map<string, ExportBinding>();

    for (const node of ast.body) {
        if (node.type === 'ExportNamedDeclaration') {
            collectNamedExportBindings(node, scopeAnalysis, resolveSource, exportsByName);
            continue;
        }

        if (node.type === 'ExportDefaultDeclaration') {
            exportsByName.set('default', { kind: 'unsupported', reason: 'default export' });
            continue;
        }

        if (node.type === 'ExportAllDeclaration') {
            collectNamespaceExportBinding(node, resolveSource, exportsByName);
        }
    }

    return exportsByName;
}

function collectNamedExportBindings(
    node: ExportNamedDeclaration,
    scopeAnalysis: ModuleScopeAnalysis,
    resolveSource: (source: string) => string,
    exportsByName: Map<string, ExportBinding>,
): void {
    if (node.declaration) {
        collectDeclarationExportBindings(node.declaration, scopeAnalysis, exportsByName);
        return;
    }

    if (node.source && isStringLiteral(node.source)) {
        const resolvedId = resolveSource(node.source.value);
        for (const specifier of node.specifiers) {
            if (specifier.type !== 'ExportSpecifier') {
                continue;
            }
            const exportedName = getModuleExportName(specifier.exported);
            if (exportedName === 'default') {
                exportsByName.set(exportedName, {
                    kind: 'unsupported',
                    reason: 'default re-export',
                    resolvedId,
                });
                continue;
            }
            exportsByName.set(exportedName, {
                kind: 're-export',
                importedName: getModuleExportName(specifier.local),
                resolvedId,
            });
        }
        return;
    }

    for (const specifier of node.specifiers) {
        if (specifier.type !== 'ExportSpecifier') {
            continue;
        }
        const exportedName = getModuleExportName(specifier.exported);
        if (exportedName === 'default') {
            exportsByName.set(exportedName, {
                kind: 'unsupported',
                reason: 'default export',
            });
            continue;
        }
        const variable = getModuleVariable(getModuleExportName(specifier.local), scopeAnalysis);
        exportsByName.set(
            exportedName,
            variable
                ? { kind: 'local', variable }
                : { kind: 'unsupported', reason: 'unresolved local export' },
        );
    }
}

function collectDeclarationExportBindings(
    declaration: ExportNamedDeclaration['declaration'],
    scopeAnalysis: ModuleScopeAnalysis,
    exportsByName: Map<string, ExportBinding>,
): void {
    if (!declaration) {
        return;
    }

    if (declaration.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations) {
            const variables = scopeAnalysis.scopeManager.getDeclaredVariables(declarator);
            if (declarator.id.type !== 'Identifier') {
                for (const variable of variables) {
                    exportsByName.set(variable.name, {
                        kind: 'unsupported',
                        reason: BINDING_PATTERN_EXPORT_REASON,
                    });
                }
                continue;
            }

            const [variable] = variables;
            if (variable) {
                exportsByName.set(declarator.id.name, { kind: 'local', variable });
            }
        }
        return;
    }

    if (
        (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') &&
        declaration.id
    ) {
        const [variable] = scopeAnalysis.scopeManager.getDeclaredVariables(declaration);
        if (variable) {
            exportsByName.set(declaration.id.name, { kind: 'local', variable });
        }
    }
}

function collectNamespaceExportBinding(
    node: ExportAllDeclaration,
    resolveSource: (source: string) => string,
    exportsByName: Map<string, ExportBinding>,
): void {
    const exported = getExportAllExportedName(node);
    if (!exported || !isStringLiteral(node.source)) {
        return;
    }

    exportsByName.set(exported, {
        kind: 'unsupported',
        reason: 'namespace re-export',
        resolvedId: resolveSource(node.source.value),
    });
}

function collectStarExports(ast: Program, resolveSource: (source: string) => string): StarExport[] {
    return ast.body.flatMap((node) => {
        if (
            node.type !== 'ExportAllDeclaration' ||
            getExportAllExportedName(node) ||
            !isStringLiteral(node.source)
        ) {
            return [];
        }

        return [{ resolvedId: resolveSource(node.source.value) }];
    });
}

function collectTopLevelBindings(
    ast: Program,
    scopeAnalysis: ModuleScopeAnalysis,
): Map<eslintScope.Variable, StaticBinding> {
    const bindings = new Map<eslintScope.Variable, StaticBinding>();

    for (const node of ast.body) {
        collectTopLevelNodeBindings(node, scopeAnalysis, bindings);
    }

    markReassignedTopLevelBindings(ast, scopeAnalysis, bindings);
    return bindings;
}

function collectTopLevelNodeBindings(
    node: ModuleDeclaration | Program['body'][number],
    scopeAnalysis: ModuleScopeAnalysis,
    bindings: Map<eslintScope.Variable, StaticBinding>,
): void {
    if (node.type === 'VariableDeclaration') {
        collectVariableDeclarationBindings(node, scopeAnalysis, bindings);
        return;
    }

    if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'VariableDeclaration'
    ) {
        collectVariableDeclarationBindings(node.declaration, scopeAnalysis, bindings);
        return;
    }

    const declaration =
        node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
            ? node.declaration
            : node;
    if (
        declaration &&
        (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') &&
        declaration.id
    ) {
        const [variable] = scopeAnalysis.scopeManager.getDeclaredVariables(declaration);
        if (variable) {
            bindings.set(variable, {
                kind: 'unsupported',
                reason: `${declaration.type} binding`,
            });
        }
    }
}

function collectVariableDeclarationBindings(
    declaration: VariableDeclaration,
    scopeAnalysis: ModuleScopeAnalysis,
    bindings: Map<eslintScope.Variable, StaticBinding>,
): void {
    for (const declarator of declaration.declarations) {
        const variables = scopeAnalysis.scopeManager.getDeclaredVariables(declarator);
        if (declarator.id.type !== 'Identifier') {
            for (const variable of variables) {
                bindings.set(variable, { kind: 'unsupported', reason: 'binding pattern' });
            }
            continue;
        }

        const [variable] = variables;
        if (!variable) {
            continue;
        }
        if (declaration.kind === 'const') {
            bindings.set(variable, { kind: 'const', expression: declarator.init ?? null });
        } else {
            bindings.set(variable, {
                kind: 'mutable',
                declarationKind: declaration.kind,
            });
        }
    }
}

interface BindingWriteState {
    ast: Program;
    scopeAnalysis: ModuleScopeAnalysis;
    bindings: Map<eslintScope.Variable, StaticBinding>;
    // Variables already followed to their alias sources, for writes to the object and to its members.
    expandedObjectWrites: Set<eslintScope.Variable>;
    expandedMemberWrites: Set<eslintScope.Variable>;
}

function markReassignedTopLevelBindings(
    ast: Program,
    scopeAnalysis: ModuleScopeAnalysis,
    bindings: Map<eslintScope.Variable, StaticBinding>,
): void {
    const writeState: BindingWriteState = {
        ast,
        scopeAnalysis,
        bindings,
        expandedObjectWrites: new Set(),
        expandedMemberWrites: new Set(),
    };
    walkAst(ast, writeState, {
        AssignmentExpression(node, { state }) {
            markAssignedPattern(node.left, state);
        },
        UpdateExpression(node, { state }) {
            markAssignedPattern(node.argument, state);
        },
        UnaryExpression(node, { state }) {
            if (node.operator === 'delete') {
                markAssignedPattern(node.argument, state);
            }
        },
        CallExpression(node, { state }) {
            for (const target of getMutatedCallTargets(node, state.scopeAnalysis)) {
                markMutatedObject(target, state);
            }
        },
        ForInStatement(node, { state }) {
            markForIterationTarget(node.left, state);
        },
        ForOfStatement(node, { state }) {
            markForIterationTarget(node.left, state);
        },
    });
}

function markForIterationTarget(
    left: Pattern | VariableDeclaration,
    state: BindingWriteState,
): void {
    if (left.type !== 'VariableDeclaration') {
        markAssignedPattern(left, state);
    }
}

function markAssignedPattern(pattern: Pattern | Expression, state: BindingWriteState): void {
    if (pattern.type === 'Identifier') {
        markAssignedVariable(pattern, state.scopeAnalysis, state.bindings, 'reassigned binding');
        return;
    }

    if (pattern.type === 'MemberExpression') {
        markMutatedObject(pattern.object, state);
        return;
    }

    if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) {
            markAssignedPattern(
                property.type === 'RestElement' ? property.argument : property.value,
                state,
            );
        }
        return;
    }

    if (pattern.type === 'ArrayPattern') {
        for (const element of pattern.elements) {
            if (element) {
                markAssignedPattern(element, state);
            }
        }
        return;
    }

    if (pattern.type === 'RestElement') {
        markAssignedPattern(pattern.argument, state);
        return;
    }

    if (pattern.type === 'AssignmentPattern') {
        markAssignedPattern(pattern.left, state);
    }
}

export const BINDING_PATTERN_EXPORT_REASON = 'binding pattern export';

const OBJECT_MUTATORS = new Map<string, ReadonlySet<string>>([
    ['Object', new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'])],
    ['Reflect', new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf'])],
]);

/** Returns the objects that a call such as `Object.assign(target, ...)` writes to. */
export function getMutatedCallTargets(
    call: SimpleCallExpression,
    scopeAnalysis: ModuleScopeAnalysis,
): Expression[] {
    const { callee } = call;
    if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') {
        return [];
    }
    const methodName = staticMemberName(callee, scopeAnalysis);
    if (
        methodName === undefined ||
        !OBJECT_MUTATORS.get(callee.object.name)?.has(methodName) ||
        resolveIdentifier(callee.object, scopeAnalysis)
    ) {
        return [];
    }
    // `Reflect.set` writes to its receiver, the fourth argument, when one is given. With a spread
    // among the first four, both the first and fourth are marked, but not one shifted into place.
    const [target, , , receiver] = call.arguments;
    const isReflectSet = callee.object.name === 'Reflect' && methodName === 'set';
    const hasSpread = call.arguments.slice(0, 4).some((arg) => arg.type === 'SpreadElement');
    let targets = [target];
    if (isReflectSet) {
        targets = hasSpread ? [target, receiver] : [receiver ?? target];
    }
    return targets.filter(
        (argument): argument is Expression =>
            argument !== undefined && argument.type !== 'SpreadElement',
    );
}

/** A variable whose object an expression may evaluate to, or reach a member of. */
export interface ObjectRoot {
    identifier: Identifier;
    isMember: boolean;
}

/** Lists the roots of expressions such as `CONN`, `CONN.gh`, `CONN?.gh`, `CONN.gh || {}` or `a = CONN`. */
export function getObjectRoots(node: unknown, isMember = false): ObjectRoot[] {
    if (isNodeOfType(node, 'Identifier')) {
        return [{ identifier: node, isMember }];
    }
    if (isNodeOfType(node, 'MemberExpression')) {
        return getObjectRoots(node.object, true);
    }
    if (isNodeOfType(node, 'ChainExpression')) {
        return getObjectRoots(node.expression, isMember);
    }
    if (isNodeOfType(node, 'AssignmentExpression')) {
        // `a ||= b` and `a ??= b` yield `a` when it already holds an object.
        const rightRoots = getObjectRoots(node.right, isMember);
        return node.operator === '||=' || node.operator === '??='
            ? [...getObjectRoots(node.left, isMember), ...rightRoots]
            : rightRoots;
    }
    if (isNodeOfType(node, 'SequenceExpression')) {
        const lastExpression = node.expressions.at(-1);
        return getObjectRoots(lastExpression, isMember);
    }
    if (isNodeOfType(node, 'LogicalExpression')) {
        // `a && b` only yields `a` when it is falsy, which no object is.
        const rightRoots = getObjectRoots(node.right, isMember);
        return node.operator === '&&'
            ? rightRoots
            : [...getObjectRoots(node.left, isMember), ...rightRoots];
    }
    if (isNodeOfType(node, 'ConditionalExpression')) {
        return [
            ...getObjectRoots(node.consequent, isMember),
            ...getObjectRoots(node.alternate, isMember),
        ];
    }
    return [];
}

type PatternTargetKind = 'member' | 'rest';

const patternTargetsByProgram = new WeakMap<Program, Map<unknown, PatternTargetKind>>();

// Identifiers bound by destructuring: a rest element gets a new object, any other target a member.
function getPatternTargets(ast: Program): Map<unknown, PatternTargetKind> {
    let targets = patternTargetsByProgram.get(ast);
    if (!targets) {
        targets = new Map();
        walkAst(ast, targets, {
            ObjectPattern(node, { state }) {
                for (const property of node.properties) {
                    if (property.type === 'Property') {
                        markMemberTarget(property.value, state);
                    }
                }
            },
            ArrayPattern(node, { state }) {
                for (const element of node.elements) {
                    markMemberTarget(element, state);
                }
            },
            RestElement(node, { state }) {
                state.set(node.argument, 'rest');
            },
        });
        patternTargetsByProgram.set(ast, targets);
    }
    return targets;
}

function markMemberTarget(node: Pattern | null, targets: Map<unknown, PatternTargetKind>): void {
    const target = node?.type === 'AssignmentPattern' ? node.left : node;
    if (target?.type === 'Identifier' && !targets.has(target)) {
        targets.set(target, 'member');
    }
}

/**
 * Lists the roots `variable`, declared in `ast`, was assigned from. A rest element copies only
 * its source's top-level properties, so it is followed only for a write to one of its members.
 */
export function getAliasSourceRoots(
    variable: eslintScope.Variable,
    ast: Program,
    isMember: boolean,
): ObjectRoot[] {
    const patternTargets = getPatternTargets(ast);
    const roots: ObjectRoot[] = [];
    for (const reference of variable.references) {
        const targetKind = patternTargets.get(reference.identifier);
        if (!reference.writeExpr || (!isMember && targetKind === 'rest')) {
            continue;
        }
        const isSourceMember = isMember || targetKind === 'member';
        for (const root of getObjectRoots(reference.writeExpr)) {
            roots.push({ identifier: root.identifier, isMember: isSourceMember || root.isMember });
        }
    }
    return roots;
}

// A write through an alias such as `const gh = CONN.gh` or `gh = CONN.gh` also changes the object it aliases.
function markMutatedObject(writtenObject: unknown, state: BindingWriteState): void {
    const pending = getObjectRoots(writtenObject);
    for (let root = pending.pop(); root; root = pending.pop()) {
        markAssignedVariable(
            root.identifier,
            state.scopeAnalysis,
            state.bindings,
            'mutated object binding',
        );

        const variable = resolveIdentifier(root.identifier, state.scopeAnalysis);
        const expanded = root.isMember ? state.expandedMemberWrites : state.expandedObjectWrites;
        if (!variable || expanded.has(variable)) {
            continue;
        }
        expanded.add(variable);
        const sourceRoots = getAliasSourceRoots(variable, state.ast, root.isMember);
        for (const sourceRoot of sourceRoots) {
            pending.push(sourceRoot);
        }
    }
}

function markAssignedVariable(
    identifier: Identifier,
    scopeAnalysis: ModuleScopeAnalysis,
    bindings: Map<eslintScope.Variable, StaticBinding>,
    reason: string,
): void {
    const variable = resolveIdentifier(identifier, scopeAnalysis);
    if (!variable || isImportVariable(variable) || !bindings.has(variable)) {
        return;
    }

    const binding = bindings.get(variable);
    if (binding?.kind === 'mutable') {
        return;
    }
    bindings.set(variable, { kind: 'unsupported', reason });
}

function getModuleExportName(node: ModuleExportName): string {
    if (node.type === 'Identifier') {
        return node.name;
    }
    return String(node.value);
}

function getExportAllExportedName(node: ExportAllDeclaration): string | undefined {
    const exported = (node as ExportAllDeclaration & { exported?: ModuleExportName | null })
        .exported;
    return exported ? getModuleExportName(exported) : undefined;
}

/**
 * Finds dependency forms that cannot be represented by the static dependency
 * IDs supplied by the backend build collector.
 */
function collectUnsupportedModuleDependencies(
    ast: Program,
    moduleId: string,
    buildRoot: string,
): ModuleDependency[] {
    const dependencies: ModuleDependency[] = [];
    const getDynamicImportFailure = (specifier: string): ModuleDependency | undefined => {
        // A package's modules are backend source like app code, so a dynamic import into one is
        // as unfollowable as a local one. Ordinary package imports stay skipped.
        if (
            shouldFailDynamicImport(specifier) ||
            importsBackendFunctionPackage(specifier, moduleId, buildRoot)
        ) {
            return { specifier, kind: 'dynamic-import' };
        }
        return undefined;
    };

    walkAst(ast, dependencies, {
        ImportExpression(node, { state }) {
            const failure = getDynamicImportFailure(getImportExpressionSpecifier(node));
            if (failure) {
                state.push(failure);
            }
        },
        CallExpression(node, { state }) {
            if (isImportCallExpression(node)) {
                const failure = getDynamicImportFailure(getImportCallSpecifier(node));
                if (failure) {
                    state.push(failure);
                }
                return;
            }

            if (isLocalRequireCall(node)) {
                state.push({
                    specifier: getRequireSpecifier(node),
                    kind: 'require',
                });
            }
        },
    });

    return dependencies;
}

/**
 * Dynamic package imports are skipped, but local or non-literal dynamic imports
 * could hide app-local action-catalog calls and must fail closed.
 */
function shouldFailDynamicImport(specifier: string): boolean {
    return specifier === 'non-literal dynamic import' || isLocalSpecifier(specifier);
}

/**
 * Reads the static string specifier from an ESTree dynamic import expression.
 */
function getImportExpressionSpecifier(node: ImportExpression): string {
    return getLiteralSpecifier(node.source, 'non-literal dynamic import');
}

/**
 * Reads the static string specifier from Rollup's call-expression form for
 * dynamic import.
 */
function getImportCallSpecifier(node: ImportCallExpression): string {
    return getLiteralSpecifier(node.arguments[0], 'non-literal dynamic import');
}

/**
 * Reads the static string specifier from a CommonJS require call.
 */
function getRequireSpecifier(node: SimpleCallExpression): string {
    return getLiteralSpecifier(node.arguments[0], 'local require');
}

/**
 * Returns a literal string value when available, otherwise a diagnostic label
 * used in fail-closed error messages.
 */
function getLiteralSpecifier(node: unknown, fallback: string): string {
    if (isStringLiteral(node)) {
        return node.value;
    }
    return fallback;
}

/**
 * Narrows Rollup's dynamic import call-expression representation.
 */
function isImportCallExpression(node: SimpleCallExpression): node is ImportCallExpression {
    return (node.callee as { type: string }).type === 'Import';
}

/**
 * Detects local CommonJS require calls. Package require calls are ignored
 * because package modules are outside the app-local backend graph.
 */
function isLocalRequireCall(node: SimpleCallExpression): boolean {
    if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
        return false;
    }
    const [source] = node.arguments;
    return !source || !isStringLiteral(source) || isLocalSpecifier(source.value);
}

/**
 * Returns whether an import specifier points at a module of the importer's own package: a relative
 * or absolute path, or a `#` subpath import, which the package's own `imports` field maps.
 */
function isLocalSpecifier(specifier: string): boolean {
    return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#');
}

/**
 * Builds the common fail-closed error for graph shapes that could hide an
 * action-catalog connection ID.
 */
export function unsupportedModuleGraphDependency(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported local module graph for ${filePath}: ${unsupported} could hide an action-catalog connectionId.`,
    );
}
