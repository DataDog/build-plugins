// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Identifier, ObjectExpression, Property } from 'estree';

import type { DebugBundleAction, DebugBundleActionCall } from '../protocol';

import {
    type ActionCatalogCall,
    getConnectionIds,
} from './extract-connection-ids-from-module-graph';
import type { ParsedModuleRecord } from './module-graph';
import { resolveIdentifier } from './module-scope';
import { resolveStaticStringConstant } from './static-string-resolution';
import { getStaticPropertyKey, hasExpressionValue } from './type-guards';

const INPUTS_PROPERTY = 'inputs';

/**
 * Groups action-catalog calls by action FQN, with the connection IDs bound to each and every
 * call's static string inputs. Returns undefined when a call has no known FQN, so a list missing
 * it is never returned.
 */
export function listActionCalls(
    calls: ActionCatalogCall[],
    exportFqnsByModule: ReadonlyMap<string, ReadonlyMap<string, string>>,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
): DebugBundleAction[] | undefined {
    const callsByFqn = new Map<string, DebugBundleActionCall[]>();

    for (const call of calls) {
        const fqn = resolveCallFqn(call, exportFqnsByModule);
        if (!fqn) {
            return undefined;
        }
        const fqnCalls = callsByFqn.get(fqn) ?? [];
        const describedCall = describeCall(call, modules);
        fqnCalls.push(describedCall);
        callsByFqn.set(fqn, fqnCalls);
    }

    return [...callsByFqn]
        .map(([fqn, fqnCalls]) => ({
            fqn,
            connectionIds: getConnectionIds(fqnCalls),
            calls: fqnCalls,
        }))
        .sort((a, b) => (a.fqn < b.fqn ? -1 : 1));
}

function describeCall(
    { record, callSite, connectionId }: ActionCatalogCall,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
): DebugBundleActionCall {
    const [options] = callSite.arguments;
    return {
        ...(connectionId !== undefined && { connectionId }),
        inputs:
            options?.type === 'ObjectExpression'
                ? listStaticInputs(options, record.id, modules)
                : {},
    };
}

// Serializing or awaiting the call can run a getter, toJSON or then on these objects: a spread or
// computed key can add the last two, and __proto__ any of them.
function getPlainDataEntries(object: ObjectExpression): Array<[string, Property]> | undefined {
    const entries: Array<[string, Property]> = [];
    for (const property of object.properties) {
        if (property.type !== 'Property' || property.computed || property.kind !== 'init') {
            return undefined;
        }
        const key = getStaticPropertyKey(property);
        if (key === undefined || key === 'toJSON' || key === 'then' || key === '__proto__') {
            return undefined;
        }
        entries.push([key, property]);
    }
    return entries;
}

function listStaticInputs(
    options: ObjectExpression,
    moduleId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
): Record<string, string> {
    const optionEntries = getPlainDataEntries(options);
    if (!optionEntries) {
        return {};
    }
    let inputs: Property['value'] | undefined;
    for (const [key, property] of optionEntries) {
        if (key === INPUTS_PROPERTY) {
            inputs = property.value;
        }
    }
    const inputEntries =
        inputs?.type === 'ObjectExpression' ? getPlainDataEntries(inputs) : undefined;
    if (!inputEntries) {
        return {};
    }

    const resolved = new Map<string, string>();
    for (const [key, property] of inputEntries) {
        const value = resolveInputValue(property, moduleId, modules);
        if (value === undefined) {
            resolved.delete(key);
        } else {
            resolved.set(key, value);
        }
    }
    return Object.fromEntries(resolved);
}

function resolveInputValue(
    property: Property,
    moduleId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
): string | undefined {
    if (!hasExpressionValue(property)) {
        return undefined;
    }
    const result = resolveStaticStringConstant(modules, moduleId, property.value);
    return result.kind === 'resolved' ? result.value : undefined;
}

function resolveCallFqn(
    { record, callSite }: ActionCatalogCall,
    exportFqnsByModule: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | undefined {
    const { callee } = callSite;
    if (callee.type === 'Identifier') {
        const binding = getImportBinding(callee, record);
        return binding?.kind === 'named'
            ? exportFqnsByModule.get(binding.resolvedId)?.get(binding.importedName)
            : undefined;
    }
    if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.property.type === 'Identifier'
    ) {
        const binding = getImportBinding(callee.object, record);
        return binding?.kind === 'namespace'
            ? exportFqnsByModule.get(binding.resolvedId)?.get(callee.property.name)
            : undefined;
    }
    return undefined;
}

function getImportBinding(identifier: Identifier, record: ParsedModuleRecord) {
    const variable = resolveIdentifier(identifier, record.scopeAnalysis);
    return variable && record.importsByVariable.get(variable);
}
