// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Plugin, Rollup } from 'vite';

import {
    createParsedModuleRecord,
    type ParsedModuleRecord,
    resolveStaticModuleSources,
    shouldTraverseCollectedModule,
    unsupportedModuleGraphDependency,
} from '../backend/ast-parsing/module-graph';
import { ensureProgram } from '../backend/ast-parsing/type-guards';

const VIRTUAL_MODULE_ID_RE = /^(?:\0|virtual:)/;

export interface BackendModuleGraphCollector {
    plugin: Plugin;
    getModuleRecords: () => ReadonlyMap<string, ParsedModuleRecord>;
}

export function createBackendModuleGraphCollector(buildRoot: string): BackendModuleGraphCollector {
    const records = new Map<string, ParsedModuleRecord>();

    return {
        plugin: {
            name: 'dd-backend-module-graph-collector',
            // Sequential so the record is stored before later plugins' `moduleParsed`
            // runs: Rollup otherwise starts them in parallel with this async handler,
            // and the static-checks plugin would miss the record and re-parse.
            moduleParsed: {
                sequential: true,
                async handler(moduleInfo: Rollup.ModuleInfo) {
                    const moduleId = normalizeViteModuleId(moduleInfo.id);
                    if (isViteVirtualModuleId(moduleId)) {
                        return;
                    }

                    // `createParsedModuleRecord` applies this same predicate, but
                    // only after the AST exists. Checking it here keeps us from
                    // parsing every `node_modules` module just to discard it.
                    if (!shouldTraverseCollectedModule(moduleId, buildRoot)) {
                        return;
                    }

                    // External and synthetic modules have no source to parse.
                    if (typeof moduleInfo.code !== 'string') {
                        return;
                    }

                    // Parse the source instead of reading `moduleInfo.ast`: Rolldown,
                    // the bundler Vite 8 uses by default, stubs that getter to throw
                    // `UNSUPPORTED: ModuleInfo#ast`.
                    //
                    // No TypeScript-capable parser is needed because `moduleParsed`
                    // runs after `transform`, so types and JSX are already compiled
                    // away. Note that `this.parse` is the bundler's parser but not
                    // its parser *configuration* — Rollup binds no options to it,
                    // while its own module parse passes `{ jsx }`. Our nested build
                    // never enables `jsx`, so the two agree today; fail closed rather
                    // than silently if they ever diverge, since a module we cannot
                    // parse may hide a connection ID.
                    let parsed;
                    try {
                        parsed = this.parse(moduleInfo.code);
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        throw unsupportedModuleGraphDependency(
                            moduleId,
                            `unparseable module source (${reason})`,
                        );
                    }

                    const program = ensureProgram(parsed, moduleId);
                    const loadedIds = moduleInfo.importedIds.map(normalizeViteModuleId);
                    const loadedIdSet = new Set(loadedIds);
                    const resolveLoadedDependency = async (source: string) => {
                        const resolved = await this.resolve(source, moduleInfo.id);
                        if (!resolved) {
                            return null;
                        }
                        const resolvedId = normalizeViteModuleId(resolved.id);
                        // This re-resolution can disagree with the bundler's own (e.g. a
                        // resolver that reads import attributes); never graph an app
                        // module the bundler didn't load. Package modules aren't walked.
                        const isAppModule = shouldTraverseCollectedModule(resolvedId, buildRoot);
                        if (isAppModule && !loadedIdSet.has(resolvedId)) {
                            throw unsupportedModuleGraphDependency(
                                moduleId,
                                `import "${source}" resolving to ${resolvedId}, which the bundler did not load,`,
                            );
                        }
                        return resolvedId;
                    };
                    const staticDependencies = await resolveStaticModuleSources(
                        program,
                        moduleId,
                        resolveLoadedDependency,
                    );
                    const resolvedIds = staticDependencies.map(({ resolvedId }) => resolvedId);
                    const resolvedIdSet = new Set(resolvedIds);
                    // App modules only: Rolldown also lists `require()` targets, and a
                    // package one is never walked.
                    const appLocalLoadedIds = loadedIds.filter((id) =>
                        shouldTraverseCollectedModule(id, buildRoot),
                    );
                    const unresolvedLoadedId = appLocalLoadedIds.find(
                        (id) => !resolvedIdSet.has(id),
                    );
                    if (unresolvedLoadedId) {
                        throw unsupportedModuleGraphDependency(
                            moduleId,
                            `loaded import ${unresolvedLoadedId} that no static import/export source resolves to`,
                        );
                    }
                    const record = createParsedModuleRecord(
                        moduleId,
                        buildRoot,
                        program,
                        staticDependencies,
                    );
                    // Only null when the traversal predicate rejects, which the guard
                    // above already covered; kept to narrow the nullable return type.
                    if (!record) {
                        return;
                    }

                    records.set(record.id, record);
                },
            },
        },
        getModuleRecords() {
            return records;
        },
    };
}

export function normalizeViteModuleId(id: string): string {
    return id.split('?')[0];
}

export function isViteVirtualModuleId(id: string): boolean {
    return VIRTUAL_MODULE_ID_RE.test(id);
}
