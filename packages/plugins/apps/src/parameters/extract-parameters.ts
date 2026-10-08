// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    CallExpression,
    ExportSpecifier,
    Expression,
    ImportSpecifier,
    Node,
    ObjectExpression,
    Program,
    Property,
    SpreadElement,
} from 'estree';

import { analyzeModuleScope, getModuleVariable } from '../backend/ast-parsing/module-scope';
import { walkAst } from '../backend/ast-parsing/walk-ast';
import type { AppsParameterSchema } from '../types';

export const PARAMETERS_MODULE = '@datadog/apps-frontend/parameters';
const DEFINE_FUNCTION = 'defineDatadogAppParameters';
const SCHEMA_TYPES = { string: 'STRING', number: 'NUMBER', boolean: 'BOOLEAN' } as const;
const PARAMETER_KEYS = new Set(['type', 'default', 'label', 'description', 'options']);

type Primitive = string | number | boolean;
type NodeWithStart = Node & { start: number };

function propertyName(property: Property, describe: () => string): string {
    if (!property.computed && property.key.type === 'Identifier') {
        return property.key.name;
    }
    if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
        return property.key.value;
    }
    throw new Error(`${describe()}: property names must be written literally.`);
}

function literalProperties(
    node: ObjectExpression,
    describe: () => string,
): Array<[string, Expression]> {
    return node.properties.map((property: Property | SpreadElement) => {
        if (property.type !== 'Property' || property.kind !== 'init' || property.method) {
            throw new Error(`${describe()}: spreads, getters, and methods are not supported.`);
        }
        return [propertyName(property, describe), property.value as Expression];
    });
}

function literalValue(node: Node, describe: () => string): Primitive {
    if (node.type === 'Literal' && ['string', 'number', 'boolean'].includes(typeof node.value)) {
        return node.value as Primitive;
    }
    if (
        node.type === 'UnaryExpression' &&
        node.operator === '-' &&
        node.argument.type === 'Literal' &&
        typeof node.argument.value === 'number'
    ) {
        return -node.argument.value;
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis.map((quasi) => quasi.value.cooked ?? '').join('');
    }
    throw new Error(`${describe()}: values must be literal strings, numbers, or booleans.`);
}

function toSchema(name: string, node: Node, describe: () => string): AppsParameterSchema {
    const where = () => `${describe()} parameter "${name}"`;
    if (node.type !== 'ObjectExpression') {
        throw new Error(`${where()}: must be an object literal.`);
    }
    const fields = new Map(literalProperties(node, where));
    for (const key of fields.keys()) {
        if (!PARAMETER_KEYS.has(key)) {
            throw new Error(`${where()}: unknown field "${key}".`);
        }
    }
    const type = fields.get('type');
    const typeName = type && literalValue(type, where);
    if (typeof typeName !== 'string' || !(typeName in SCHEMA_TYPES)) {
        throw new Error(`${where()}: type must be 'string', 'number', or 'boolean'.`);
    }
    const defaultValue = fields.get('default');
    if (!defaultValue) {
        throw new Error(`${where()}: needs a default.`);
    }
    const text = (key: 'label' | 'description') => {
        const value = fields.get(key);
        return value === undefined ? {} : { [key]: String(literalValue(value, where)) };
    };
    const options = fields.get('options');
    if (options !== undefined && options.type !== 'ArrayExpression') {
        throw new Error(`${where()}: options must be an array literal.`);
    }
    return {
        name,
        type: SCHEMA_TYPES[typeName as keyof typeof SCHEMA_TYPES],
        defaultValue: literalValue(defaultValue, where),
        ...text('label'),
        ...text('description'),
        ...(options === undefined
            ? {}
            : {
                  enum: options.elements.map((element) => {
                      const value = element && literalValue(element, where);
                      if (typeof value !== 'string') {
                          throw new Error(`${where()}: options must be strings.`);
                      }
                      return value;
                  }),
              }),
    };
}

function importedName(specifier: ImportSpecifier | ExportSpecifier): string {
    const name = 'imported' in specifier ? specifier.imported : specifier.local;
    return name.type === 'Identifier' ? name.name : String(name.value);
}

function parentsOf(program: Program): Map<Node, Node> {
    const parents = new Map<Node, Node>();
    walkAst(program as Node, parents, {
        _(node) {
            for (const value of Object.values(node)) {
                for (const child of Array.isArray(value) ? value : [value]) {
                    if (child && typeof child === 'object' && typeof child.type === 'string') {
                        parents.set(child as Node, node as Node);
                    }
                }
            }
        },
    });
    return parents;
}

/**
 * Finds every `defineDatadogAppParameters({...})` call in one compiled module,
 * including calls passed straight to `useDatadogAppParameters()`. Calls are
 * found through the imported binding, not by name, and every other use of the
 * function fails the build: a declaration the build cannot read must never be
 * silently left out of the manifest.
 */
export function extractParameterDeclarations(
    program: Program,
    moduleId: string,
): AppsParameterSchema[][] {
    const describe = () => `${DEFINE_FUNCTION}() in ${moduleId}`;
    const unsupported = (use: string) =>
        new Error(
            `${describe()}: ${use} is not supported. Call ${DEFINE_FUNCTION} directly with an object literal so the build can read the declaration.`,
        );

    const functionNames = new Set<string>();
    const namespaceNames = new Set<string>();
    walkAst(program as Node, null, {
        ImportDeclaration(declaration) {
            if (declaration.source.value !== PARAMETERS_MODULE) {
                return;
            }
            for (const specifier of declaration.specifiers) {
                if (specifier.type === 'ImportNamespaceSpecifier') {
                    namespaceNames.add(specifier.local.name);
                } else if (
                    specifier.type === 'ImportSpecifier' &&
                    importedName(specifier) === DEFINE_FUNCTION
                ) {
                    functionNames.add(specifier.local.name);
                }
            }
        },
        ExportNamedDeclaration(declaration) {
            if (
                declaration.source?.value === PARAMETERS_MODULE &&
                declaration.specifiers.some(
                    (specifier) => importedName(specifier) === DEFINE_FUNCTION,
                )
            ) {
                throw unsupported('re-exporting the function');
            }
        },
        ExportAllDeclaration(declaration) {
            if (declaration.source.value === PARAMETERS_MODULE) {
                throw unsupported('re-exporting the module');
            }
        },
        ImportExpression(expression) {
            if (
                expression.source.type === 'Literal' &&
                expression.source.value === PARAMETERS_MODULE
            ) {
                throw unsupported('importing the module dynamically');
            }
        },
    });
    if (functionNames.size === 0 && namespaceNames.size === 0) {
        return [];
    }

    const scope = analyzeModuleScope(program);
    const parents = parentsOf(program);
    const calls: CallExpression[] = [];
    const callOf = (callee: Node): CallExpression => {
        const call = parents.get(callee);
        if (call?.type !== 'CallExpression' || call.callee !== callee) {
            throw unsupported('using the function other than by calling it');
        }
        return call;
    };
    for (const name of [...functionNames, ...namespaceNames]) {
        const variable = getModuleVariable(name, scope);
        for (const reference of variable?.references ?? []) {
            const identifier = reference.identifier as Node;
            if (functionNames.has(name)) {
                calls.push(callOf(identifier));
                continue;
            }
            const member = parents.get(identifier);
            if (
                member?.type !== 'MemberExpression' ||
                member.object !== identifier ||
                member.computed ||
                member.property.type !== 'Identifier'
            ) {
                throw unsupported('using the module namespace other than as `namespace.member`');
            }
            if (member.property.name === DEFINE_FUNCTION) {
                calls.push(callOf(member));
            }
        }
    }

    return calls
        .sort((left, right) => (left as NodeWithStart).start - (right as NodeWithStart).start)
        .map((call) => {
            const [declaration] = call.arguments;
            if (call.arguments.length !== 1 || declaration.type !== 'ObjectExpression') {
                throw unsupported('passing anything other than one object literal');
            }
            return literalProperties(declaration, describe).map(([name, value]) =>
                toSchema(name, value, describe),
            );
        });
}

/**
 * Combines declarations from every module into the app's one declaration, in
 * module then source order. The same name may be declared in several places
 * only if each declaration is identical.
 */
export function mergeParameterDeclarations(
    declarationsByModule: ReadonlyMap<string, AppsParameterSchema[][]>,
): AppsParameterSchema[] {
    const merged = new Map<string, { parameter: AppsParameterSchema; moduleId: string }>();
    for (const moduleId of [...declarationsByModule.keys()].sort()) {
        for (const declaration of declarationsByModule.get(moduleId) ?? []) {
            for (const parameter of declaration) {
                const existing = merged.get(parameter.name);
                if (!existing) {
                    merged.set(parameter.name, { parameter, moduleId });
                } else if (JSON.stringify(existing.parameter) !== JSON.stringify(parameter)) {
                    throw new Error(
                        `App parameter "${parameter.name}" is declared differently in ${existing.moduleId} and ${moduleId}. Declare it once, or identically everywhere.`,
                    );
                }
            }
        }
    }
    return [...merged.values()].map(({ parameter }) => parameter);
}
