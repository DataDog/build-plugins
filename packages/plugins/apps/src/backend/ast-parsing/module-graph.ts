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
    Super,
    VariableDeclaration,
} from 'estree';
import path from 'path';

import { BACKEND_CODE_EXTENSIONS } from '../../constants';

import {
    analyzeModuleScope,
    getModuleVariable,
    isImportVariable,
    type ModuleScopeAnalysis,
    resolveIdentifier,
} from './module-scope';
import { ensureProgram, isStringLiteral } from './type-guards';
import { walkAst } from './walk-ast';

/**
 * Parsed app-local backend module plus reusable static facts about its module
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

const PACKAGE_MANAGER_DIRS = new Set(['node_modules', '.yarn']);

/**
 * Creates the per-module analysis record consumed by backend-entry reachability
 * analysis. The caller supplies canonical module IDs and already-resolved
 * static dependency IDs instead of asking this module to resolve/load files.
 *
 * Returns null when the module is outside the analyzable app-local backend
 * graph, allowing build collectors to skip package/generated modules without
 * duplicating graph filtering rules.
 */
export function createParsedModuleRecord(
    moduleId: string,
    buildRoot: string,
    ast: BaseNode,
    staticDependencies: string[] = [],
): ParsedModuleRecord | null {
    if (!shouldTraverseCollectedModule(moduleId, buildRoot)) {
        return null;
    }

    const program = ensureProgram(ast, moduleId);
    const scopeAnalysis = analyzeModuleScope(program);
    const staticModuleDependencies = collectStaticModuleDependencies(program, staticDependencies);

    return {
        id: moduleId,
        ast: program,
        scopeAnalysis,
        staticDependencies: staticModuleDependencies,
        unsupportedDependencies: collectUnsupportedModuleDependencies(program),
        importsByVariable: collectImportBindings(program, scopeAnalysis, staticModuleDependencies),
        exportsByName: collectExportBindings(program, scopeAnalysis, staticModuleDependencies),
        starExports: collectStarExports(program, staticModuleDependencies),
        topLevelBindingsByVariable: collectTopLevelBindings(program, scopeAnalysis),
    };
}

function collectStaticModuleDependencies(
    ast: Program,
    staticDependencyIds: string[],
): StaticModuleDependency[] {
    const staticModuleSources = getStaticModuleSources(ast);

    return staticDependencyIds.map((resolvedId, index) => ({
        source: staticModuleSources[index] ?? resolvedId,
        resolvedId,
    }));
}

function getStaticModuleSources(ast: Program): string[] {
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
    staticDependencies: StaticModuleDependency[],
): Map<eslintScope.Variable, ImportBinding> {
    const importsByVariable = new Map<eslintScope.Variable, ImportBinding>();

    for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration' || !isStringLiteral(node.source)) {
            continue;
        }

        const resolvedId = getResolvedSource(staticDependencies, node.source.value);
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
    staticDependencies: StaticModuleDependency[],
): Map<string, ExportBinding> {
    const exportsByName = new Map<string, ExportBinding>();

    for (const node of ast.body) {
        if (node.type === 'ExportNamedDeclaration') {
            collectNamedExportBindings(node, scopeAnalysis, staticDependencies, exportsByName);
            continue;
        }

        if (node.type === 'ExportDefaultDeclaration') {
            exportsByName.set('default', { kind: 'unsupported', reason: 'default export' });
            continue;
        }

        if (node.type === 'ExportAllDeclaration') {
            collectNamespaceExportBinding(node, staticDependencies, exportsByName);
        }
    }

    return exportsByName;
}

function collectNamedExportBindings(
    node: ExportNamedDeclaration,
    scopeAnalysis: ModuleScopeAnalysis,
    staticDependencies: StaticModuleDependency[],
    exportsByName: Map<string, ExportBinding>,
): void {
    if (node.declaration) {
        collectDeclarationExportBindings(node.declaration, scopeAnalysis, exportsByName);
        return;
    }

    if (node.source && isStringLiteral(node.source)) {
        const resolvedId = getResolvedSource(staticDependencies, node.source.value);
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
                        reason: 'binding pattern export',
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
    staticDependencies: StaticModuleDependency[],
    exportsByName: Map<string, ExportBinding>,
): void {
    const exported = getExportAllExportedName(node);
    if (!exported || !isStringLiteral(node.source)) {
        return;
    }

    exportsByName.set(exported, {
        kind: 'unsupported',
        reason: 'namespace re-export',
        resolvedId: getResolvedSource(staticDependencies, node.source.value),
    });
}

function collectStarExports(
    ast: Program,
    staticDependencies: StaticModuleDependency[],
): StarExport[] {
    return ast.body.flatMap((node) => {
        if (
            node.type !== 'ExportAllDeclaration' ||
            getExportAllExportedName(node) ||
            !isStringLiteral(node.source)
        ) {
            return [];
        }

        return [{ resolvedId: getResolvedSource(staticDependencies, node.source.value) }];
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

function markReassignedTopLevelBindings(
    ast: Program,
    scopeAnalysis: ModuleScopeAnalysis,
    bindings: Map<eslintScope.Variable, StaticBinding>,
): void {
    walkAst(
        ast,
        { scopeAnalysis, bindings },
        {
            AssignmentExpression(node, { state }) {
                markAssignedPattern(node.left, state.scopeAnalysis, state.bindings);
            },
            UpdateExpression(node, { state }) {
                markAssignedPattern(node.argument, state.scopeAnalysis, state.bindings);
            },
            UnaryExpression(node, { state }) {
                if (node.operator === 'delete') {
                    markAssignedPattern(node.argument, state.scopeAnalysis, state.bindings);
                }
            },
            ForInStatement(node, { state }) {
                markForIterationTarget(node.left, state.scopeAnalysis, state.bindings);
            },
            ForOfStatement(node, { state }) {
                markForIterationTarget(node.left, state.scopeAnalysis, state.bindings);
            },
        },
    );
}

function markForIterationTarget(
    left: Pattern | VariableDeclaration,
    scopeAnalysis: ModuleScopeAnalysis,
    bindings: Map<eslintScope.Variable, StaticBinding>,
): void {
    if (left.type !== 'VariableDeclaration') {
        markAssignedPattern(left, scopeAnalysis, bindings);
    }
}

function markAssignedPattern(
    pattern: Pattern | Expression,
    scopeAnalysis: ModuleScopeAnalysis,
    bindings: Map<eslintScope.Variable, StaticBinding>,
): void {
    if (pattern.type === 'Identifier') {
        markAssignedVariable(pattern, scopeAnalysis, bindings, 'reassigned binding');
        return;
    }

    if (pattern.type === 'MemberExpression') {
        const root = getMemberExpressionRoot(pattern);
        if (root) {
            markAssignedVariable(root, scopeAnalysis, bindings, 'mutated object binding');
        }
        return;
    }

    if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) {
            markAssignedPattern(
                property.type === 'RestElement' ? property.argument : property.value,
                scopeAnalysis,
                bindings,
            );
        }
        return;
    }

    if (pattern.type === 'ArrayPattern') {
        for (const element of pattern.elements) {
            if (element) {
                markAssignedPattern(element, scopeAnalysis, bindings);
            }
        }
        return;
    }

    if (pattern.type === 'RestElement') {
        markAssignedPattern(pattern.argument, scopeAnalysis, bindings);
        return;
    }

    if (pattern.type === 'AssignmentPattern') {
        markAssignedPattern(pattern.left, scopeAnalysis, bindings);
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

function getMemberExpressionRoot(node: Expression | Super): Identifier | undefined {
    if (node.type === 'Identifier') {
        return node;
    }
    if (node.type === 'MemberExpression') {
        return getMemberExpressionRoot(node.object);
    }
    return undefined;
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

function getResolvedSource(staticDependencies: StaticModuleDependency[], source: string): string {
    return (
        staticDependencies.find((dependency) => dependency.source === source)?.resolvedId ?? source
    );
}

/**
 * Finds dependency forms that cannot be represented by the static dependency
 * IDs supplied by the backend build collector.
 */
function collectUnsupportedModuleDependencies(ast: Program): ModuleDependency[] {
    const dependencies: ModuleDependency[] = [];

    walkAst(ast, dependencies, {
        ImportExpression(node, { state }) {
            const specifier = getImportExpressionSpecifier(node);
            if (shouldFailDynamicImport(specifier)) {
                state.push({ specifier, kind: 'dynamic-import' });
            }
        },
        CallExpression(node, { state }) {
            if (isImportCallExpression(node)) {
                const specifier = getImportCallSpecifier(node);
                if (shouldFailDynamicImport(specifier)) {
                    state.push({ specifier, kind: 'dynamic-import' });
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
 * Keeps reachability traversal scoped to app-local JavaScript/TypeScript source
 * modules that the backend build collector can safely analyze.
 */
export function shouldTraverseCollectedModule(moduleId: string, buildRoot: string): boolean {
    if (!BACKEND_CODE_EXTENSIONS.some((extension) => moduleId.endsWith(extension))) {
        return false;
    }

    const relativePath = path.relative(path.resolve(buildRoot), moduleId);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return false;
    }

    return !relativePath.split(path.sep).some((segment) => PACKAGE_MANAGER_DIRS.has(segment));
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
 * Returns whether an import specifier points at an app-local path.
 */
function isLocalSpecifier(specifier: string): boolean {
    return specifier.startsWith('.') || specifier.startsWith('/');
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
