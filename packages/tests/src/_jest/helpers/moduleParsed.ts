// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getStaticModuleSources } from '@dd/apps-plugin/backend/ast-parsing/module-graph';
import path from 'path';
import { parseAst } from 'rollup/parseAst';

type FixtureModuleInfo = { id: string; code: string; importedIds: string[] };
type ModuleParsedHandler = (this: unknown, moduleInfo: FixtureModuleInfo) => unknown;
type ModuleParsedHook =
    | ModuleParsedHandler
    | { handler: ModuleParsedHandler; sequential?: boolean };

// Like the bundler's resolver for these fixtures: relative specifiers resolve
// against the importer, and a bare package specifier resolves to itself.
export const resolveFixtureSpecifier = (source: string, importer: string): string => {
    if (!source.startsWith('.')) {
        return source;
    }
    const importerDir = path.posix.dirname(importer);
    return path.posix.resolve(importerDir, source);
};

const pluginContext = {
    parse: parseAst,
    resolve: async (source: string, importer: string) => {
        const id = resolveFixtureSpecifier(source, importer);
        return { id, external: !source.startsWith('.') };
    },
};

// The bundler's `importedIds` for a bundler whose resolution agrees with
// `pluginContext.resolve`, in Rolldown's shape (one entry per distinct resolved ID).
const getImportedIds = (id: string, code: string): string[] => {
    const program = parseAst(code);
    const sources = getStaticModuleSources(program);
    const importedIds = sources.map((source) => resolveFixtureSpecifier(source, id));
    return [...new Set(importedIds)];
};

// Runs every plugin's `moduleParsed` hook for `id` the way Rollup's `hookParallel`
// does: handlers start together, except a `sequential` one, which waits for
// those before it and blocks those after it. Plugin `order` is not modeled.
export const emitModuleParsed = async (
    config: { plugins: Array<{ moduleParsed?: ModuleParsedHook }> },
    id: string,
    code: string,
) => {
    const importedIds = getImportedIds(id, code);
    const moduleInfo = { id, code, importedIds };
    let running: unknown[] = [];
    for (const plugin of config.plugins) {
        const hook = plugin.moduleParsed;
        if (!hook) {
            continue;
        }
        const handler = typeof hook === 'function' ? hook : hook.handler;
        const isSequential = typeof hook !== 'function' && Boolean(hook.sequential);
        // Like Rollup's `runHook`: a synchronous throw becomes a rejection.
        const start = () => Promise.resolve().then(() => handler.call(pluginContext, moduleInfo));
        if (isSequential) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(running);
            running = [];
            // eslint-disable-next-line no-await-in-loop
            await start();
        } else {
            const result = start();
            running.push(result);
        }
    }
    await Promise.all(running);
};
