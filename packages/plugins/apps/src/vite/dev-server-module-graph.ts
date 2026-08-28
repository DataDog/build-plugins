// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { parseAst } from 'rollup/parseAst';
import type { ModuleNode, ViteDevServer } from 'vite';

import {
    createParsedModuleRecord,
    getStaticModuleSources,
    type ParsedModuleRecord,
    shouldTraverseCollectedModule,
    unsupportedModuleGraphDependency,
} from '../backend/ast-parsing/module-graph';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

/**
 * Builds the same `ReadonlyMap<string, ParsedModuleRecord>` shape
 * `createBackendModuleGraphCollector`'s `moduleParsed` hook produces during a
 * real Rollup build — but for the dev server, where `moduleParsed` never
 * fires at all (it's a Rollup-build-only hook; Vite's dev-server plugin
 * container doesn't implement it). Instead, this walks Vite's own
 * `server.moduleGraph`, which the dev server already populates as a side
 * effect of `ssrLoadModule`: by the time an `await server.ssrLoadModule(id)`
 * call resolves, the entry's `ModuleNode.importedModules` — and every
 * imported module's own `importedModules` — already reflect the full
 * transitive static-import graph, recursively, with no extra ticks needed.
 *
 * Parses each module's own source read fresh from disk (via `ModuleNode.file`),
 * stripped of TS/JSX syntax by `esbuild.transform` in isolation, rather than
 * either of Vite's own transform results: the client transform
 * (`transformResult`) doesn't run for an SSR-only load, and the SSR transform
 * (`ssrTransformResult`) rewrites every `import` into a `__vite_ssr_import__(...)`
 * call and resolves bare specifiers to absolute paths — neither shape
 * `collectActionCatalogImports`'s plain-`ImportDeclaration` search (built for
 * the untransformed syntax a real Rollup build sees) can parse. `esbuild.transform`
 * in isolation only strips types/JSX; it doesn't touch import specifiers at all,
 * so this reads exactly the same syntax the production build path already trusts.
 *
 * Call this only after `loadModule` has resolved for `bareEntryId +
 * LOCAL_EXECUTION_LOAD_SUFFIX` in the same request — the graph it reads is a
 * live side effect of that call, not independently maintained state.
 * `bareEntryId` is the same unsuffixed id `extractConnectionIdsFromModuleGraph`
 * needs to key into the returned map below; the suffix is appended here,
 * internally, rather than left to each caller to remember — Vite keys the
 * node it just loaded by the full resolved id (suffix included), since it
 * treats each distinct query string as a logically distinct module.
 */
export async function collectModuleGraphFromServer(
    server: ViteDevServer,
    bareEntryId: string,
    buildRoot: string,
): Promise<ReadonlyMap<string, ParsedModuleRecord>> {
    const records = new Map<string, ParsedModuleRecord>();
    const visited = new Set<string>();
    const pending: ModuleNode[] = [];

    const entryNode = server.moduleGraph.getModuleById(bareEntryId + LOCAL_EXECUTION_LOAD_SUFFIX);
    if (entryNode) {
        pending.push(entryNode);
    }

    while (pending.length > 0) {
        const node = pending.shift()!;
        const moduleId = node.id ? normalizeViteModuleId(node.id) : undefined;
        if (!moduleId || visited.has(moduleId) || !node.file) {
            continue;
        }
        visited.add(moduleId);

        if (!shouldTraverseCollectedModule(moduleId, buildRoot)) {
            continue;
        }

        let source: string;
        try {
            source = await readFile(node.file, 'utf-8');
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw unsupportedModuleGraphDependency(
                moduleId,
                `unreadable module source (${reason})`,
            );
        }

        let ast;
        try {
            const stripped = await transform(source, {
                loader: loaderForModuleId(moduleId),
                format: 'esm',
            });
            ast = parseAst(stripped.code);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw unsupportedModuleGraphDependency(
                moduleId,
                `unparseable module source (${reason})`,
            );
        }

        // `node.importedModules` mixes static AND dynamic imports with no
        // documented ordering guarantee, but `createParsedModuleRecord`
        // zips dependency ids positionally against the AST's own static
        // import/export declarations — so this list must contain ONLY
        // static dependencies, in that same order. The dev server's plugin
        // container doesn't populate Rollup-style `ModuleInfo.importedIds`
        // outside a real build, so this resolves each of the AST's own
        // static specifiers individually instead, via the same resolution
        // Vite itself would use — guaranteeing a correct 1:1 correspondence
        // by construction, since both sides are derived from this same ast.
        const staticModuleSources = getStaticModuleSources(ast);
        const importerFile = node.file;
        const resolutions = await Promise.all(
            staticModuleSources.map((moduleSource) =>
                server.pluginContainer.resolveId(moduleSource, importerFile ?? undefined, {
                    ssr: true,
                }),
            ),
        );
        const staticDependencyIds = resolutions.map((resolved, index) => {
            if (!resolved) {
                // Fail closed rather than trusting an incomplete allowlist — falling back to the raw specifier text would let a connectionId-scoped call behind an unresolvable import silently drop out of extractConnectionIdsFromModuleGraph's allowlist instead of the whole request failing loudly.
                throw unsupportedModuleGraphDependency(
                    moduleId,
                    `unresolvable import specifier "${staticModuleSources[index]}"`,
                );
            }
            return normalizeViteModuleId(resolved.id);
        });

        const record = createParsedModuleRecord(moduleId, buildRoot, ast, staticDependencyIds);
        if (record) {
            records.set(record.id, record);
        }

        for (const dependencyNode of node.importedModules) {
            pending.push(dependencyNode);
        }
    }

    return records;
}

function loaderForModuleId(moduleId: string): 'ts' | 'tsx' | 'jsx' | 'js' {
    if (moduleId.endsWith('.tsx')) {
        return 'tsx';
    }
    if (moduleId.endsWith('.ts') || moduleId.endsWith('.mts') || moduleId.endsWith('.cts')) {
        return 'ts';
    }
    if (moduleId.endsWith('.jsx')) {
        return 'jsx';
    }
    return 'js';
}

function normalizeViteModuleId(id: string): string {
    return id.split('?')[0];
}
