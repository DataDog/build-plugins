// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import path from 'path';
import type { build } from 'vite';

import {
    getAuthenticatedRequest,
    MissingAuthenticationError,
    type DoAuthenticatedRequest,
} from '../auth';
import { extractExportedFunctions } from '../backend/ast-parsing/extract-backend-functions';
import { extractConnectionIdsFromModuleGraph } from '../backend/ast-parsing/extract-connection-ids-from-module-graph';
import { analyzeModuleScope } from '../backend/ast-parsing/module-scope';
import { runBackendStaticChecks } from '../backend/ast-parsing/run-backend-static-checks';
import { ensureProgram } from '../backend/ast-parsing/type-guards';
import { encodeQueryName } from '../backend/encodeQueryName';
import { generateProxyModule } from '../backend/proxy-codegen';
import type { BackendFunction } from '../backend/types';
import {
    BACKEND_FILE_RE,
    BACKEND_FILE_WITH_QUERY_RE,
    LOCAL_EXECUTION_LOAD_SUFFIX,
    PLUGIN_NAME,
} from '../constants';
import type { AppsOptionsWithDefaults } from '../types';

import { buildBackendFunctions } from './build-backend-functions';
import { collectModuleGraphFromServer } from './dev-server-module-graph';
import { createDevServerMiddleware } from './dev-server';
import { handleUpload } from './handle-upload';
import { localExecutionResolutionContext } from './local-execution';

export type ViteBundler = {
    build: typeof build;
};

export interface VitePluginOptions {
    bundler: ViteBundler;
    context: GlobalContext;
    options: AppsOptionsWithDefaults;
}

/**
 * Build BackendFunction entries from discovered export names and generate
 * the frontend proxy module that replaces the original backend code.
 */
function buildProxyModule(
    exportNames: string[],
    id: string,
    buildRoot: string,
): { functions: BackendFunction[]; proxyCode: string } {
    const relativePath = path.relative(buildRoot, id);
    const refPath = relativePath.replace(BACKEND_FILE_RE, '');

    const functions: BackendFunction[] = [];
    const proxyExports: Array<{ exportName: string; queryName: string }> = [];

    for (const exportName of exportNames) {
        const func = {
            relativePath: refPath,
            name: exportName,
            absolutePath: id,
            allowedConnectionIds: [],
        };
        functions.push(func);
        proxyExports.push({ exportName, queryName: encodeQueryName(func) });
    }

    return { functions, proxyCode: generateProxyModule(proxyExports) };
}

/**
 * Create a registry for tracking discovered backend functions.
 * Uses a Map keyed by entryPath so that re-transforms (e.g. during HMR)
 * replace stale entries for a file instead of appending duplicates.
 */
function createBackendFunctionRegistry() {
    const functionsByEntryPath = new Map<string, BackendFunction[]>();

    return {
        /** Replace all entries for a given file. Handles HMR re-transforms. */
        setBackendFunctions(entryPath: string, functions: BackendFunction[]) {
            functionsByEntryPath.set(entryPath, functions);
        },
        /** Get a flat array of all currently registered backend functions. */
        getBackendFunctions(): BackendFunction[] {
            return Array.from(functionsByEntryPath.values()).flat();
        },
    };
}

const APPS_RUNTIME_PATH = path.join(__dirname, './apps-runtime.mjs');

const doDryRunAuthenticatedRequest: DoAuthenticatedRequest = async () => {
    throw new Error('Dry run should not perform authenticated requests.');
};

/**
 * Returns the Vite-specific plugin hooks for the apps plugin.
 *
 * Transform: discovers backend exports and connection allowlists, registers
 * backend functions, and replaces each backend module with its frontend proxy.
 *
 * Production (closeBundle): builds backend functions (if any) then uploads
 * all assets sequentially.
 *
 * Dev (configureServer): registers middleware for local backend function
 * testing when auth credentials are available.
 */
export const getVitePlugin = ({
    bundler,
    context,
    options,
}: VitePluginOptions): PluginOptions['vite'] => {
    const log = context.getLogger(PLUGIN_NAME);
    const { auth } = context;

    context.inject({
        type: 'file',
        position: InjectPosition.MIDDLE,
        value: APPS_RUNTIME_PATH,
    });

    const { setBackendFunctions, getBackendFunctions } = createBackendFunctionRegistry();

    return {
        // @datadog/apps-backend and @datadog/action-catalog ship ESM-only, but server.ssrLoadModule
        // externalizes node_modules by default (a plain require(), for speed), which throws
        // "Cannot use import statement outside a module" for them. ssr.noExternal forces Vite's
        // SSR transform pipeline to handle them instead, matching how production bundling already
        // inlines every dependency.
        config() {
            return {
                ssr: {
                    noExternal: ['@datadog/apps-backend', '@datadog/action-catalog'],
                },
            };
        },
        // Propagates the LOCAL_EXECUTION_LOAD_SUFFIX marker through the backend-file dependency
        // graph: ssrLoadModule only tags the one entry module it's called with, so without this
        // hook a `.backend.ts` file importing another `.backend.ts` file would resolve that nested
        // import unsuffixed and get replaced with the frontend RPC-proxy stub, breaking local
        // execution for a multi-backend-file graph. Propagates whenever the importer was itself
        // suffixed, or is a previously-seen non-backend module reached from within the current
        // local execution's own subgraph (see `localExecutionResolutionContext`) — and only
        // appends the suffix onto another `.backend.ts` file, since a plain helper module never
        // hits the proxy-vs-real-code branch this marker disambiguates.
        resolveId: {
            // Must run before Vite's built-in resolver: a plain relative specifier like
            // `./other.backend` is fully resolvable by Vite's own filesystem resolution, which at
            // its default order would short-circuit the hook chain before this plugin ever saw it.
            // `pre` guarantees this hook gets first look at every id.
            order: 'pre',
            async handler(source, importer, resolveOptions) {
                // Gates the whole hook, not just one branch below: local execution's traversal is
                // always an SSR resolution, so a non-SSR call can never legitimately match either
                // check that follows. Living here as a top-level guard, rather than folded into
                // each branch's own condition, means any future branch added below inherits the
                // gate automatically instead of needing to re-derive it. Without this check at
                // all, the same helper reached later from the ordinary client graph would inherit
                // the marker and serve real backend code to the browser instead of the frontend
                // RPC-proxy stub.
                if (resolveOptions.ssr !== true) {
                    return null;
                }

                // The store being present is the other half of the scoping: it's only populated
                // while a local execution's own loadModule call is in flight (see
                // configureServer), so an unrelated SSR resolution elsewhere in the process never
                // inherits a marker left behind by an earlier, already-finished execution.
                const subgraphImporters = localExecutionResolutionContext.getStore();
                const isPartOfSuffixedSubgraph =
                    !!importer &&
                    (importer.endsWith(LOCAL_EXECUTION_LOAD_SUFFIX) ||
                        (!!subgraphImporters && subgraphImporters.has(importer)));
                if (!isPartOfSuffixedSubgraph) {
                    return null;
                }

                const resolved = await this.resolve(source, importer, {
                    ...resolveOptions,
                    skipSelf: true,
                });
                if (!resolved || resolved.external) {
                    return resolved;
                }

                if (!BACKEND_FILE_RE.test(resolved.id)) {
                    subgraphImporters?.add(resolved.id);
                    return resolved;
                }

                if (!resolved.id.endsWith(LOCAL_EXECUTION_LOAD_SUFFIX)) {
                    return { ...resolved, id: resolved.id + LOCAL_EXECUTION_LOAD_SUFFIX };
                }

                return resolved;
            },
        },
        transform: {
            filter: {
                id: {
                    include: [BACKEND_FILE_WITH_QUERY_RE],
                    exclude: [/node_modules/, /[/\\]dist[/\\]/],
                },
            },
            // For each .backend.* file, parse its named exports, register
            // them as backend functions, and replace the module with a
            // frontend proxy that calls executeBackendFunction at runtime.
            handler(code, id, transformOptions) {
                if (id.endsWith(LOCAL_EXECUTION_LOAD_SUFFIX) && transformOptions?.ssr) {
                    // Local execution needs the real function body, not the proxy stub below — real loads always go through ssrLoadModule, which runs in SSR, so this only fires for that legitimate path.
                    return null;
                }
                // Any other case (no query, a spoofed client-side import reusing the suffix, or an unrecognized query) falls through to the safe proxy-stub generation below. Strip the query first so it registers under the file's real (unsuffixed) relativePath/query-name, not a duplicate.
                const queryIndex = id.indexOf('?');
                const normalizedId = queryIndex === -1 ? id : id.slice(0, queryIndex);

                const ast = this.parse(code);
                const program = ensureProgram(ast, normalizedId);
                // Shared so the checks below don't each independently re-walk the same AST to build the same scope graph.
                const scopeAnalysis = analyzeModuleScope(program);
                // Runs even for a file with zero exports, to catch a banned import/global as soon as it's written.
                runBackendStaticChecks(ast, normalizedId, log, scopeAnalysis);
                const exportNames = extractExportedFunctions(ast, normalizedId);
                if (exportNames.length === 0) {
                    // Only a genuinely no-query id can be trusted as a real re-transform of this
                    // exact file's own source. Vite's own `?raw`/`?url`/`?worker` load hooks all
                    // produce a default export, which enumerateBackendExports already rejects
                    // with a loud throw before this branch is reached — but some other
                    // query-bearing load producing zero-export content isn't ruled out, and
                    // clearing the registry for that case would silently and permanently break
                    // the file's real (unsuffixed) registration until a file edit or server
                    // restart, over an import that never touched its real source.
                    if (queryIndex === -1) {
                        log.warn(
                            `Backend file ${normalizedId} has no exported functions. ` +
                                `Did you forget to add a named export?`,
                        );
                        // Clear any previously registered functions for this file
                        // so stale entries don't persist across HMR re-transforms.
                        setBackendFunctions(normalizedId, []);
                    }
                    return { code: '', map: null };
                }

                const { functions, proxyCode } = buildProxyModule(
                    exportNames,
                    normalizedId,
                    context.buildRoot,
                );
                setBackendFunctions(normalizedId, functions);
                log.debug(`Generated proxy for ${normalizedId} with ${functions.length} export(s)`);

                return { code: proxyCode, map: null };
            },
        },
        async closeBundle() {
            let backendOutDir: string | undefined;
            let backendOutputs = new Map<string, string>();
            let backendFunctions = getBackendFunctions();
            if (backendFunctions.length > 0) {
                const result = await buildBackendFunctions(
                    bundler.build,
                    backendFunctions,
                    context.buildRoot,
                    log,
                );
                backendOutDir = result.outDir;
                backendOutputs = result.outputs;
                backendFunctions = result.functions;
            }
            try {
                const doAuthenticatedRequest = options.dryRun
                    ? doDryRunAuthenticatedRequest
                    : getAuthenticatedRequest(options.authOverrides.method, auth, log);

                await handleUpload({
                    backendOutputs,
                    backendFunctions,
                    context,
                    doAuthenticatedRequest,
                    options,
                });
            } finally {
                if (backendOutDir) {
                    await rm(backendOutDir);
                }
            }
        },
        configureServer(server) {
            let doAuthenticatedRequest: DoAuthenticatedRequest | undefined;
            try {
                doAuthenticatedRequest = getAuthenticatedRequest(
                    options.authOverrides.method,
                    auth,
                    log,
                );
            } catch (error) {
                if (!(error instanceof MissingAuthenticationError)) {
                    throw error;
                }
            }

            const loadModule = server.ssrLoadModule.bind(server);
            // Call only after `loadModule` has resolved for this same entryId — the graph read
            // below is a live side effect of that call, not independently maintained state
            // (moduleParsed, production's mechanism, is a Rollup-build-only hook that never
            // fires on a real dev server). collectModuleGraphFromServer appends
            // LOCAL_EXECUTION_LOAD_SUFFIX internally, so this closure only handles the bare path.
            const getAllowedConnectionIds = async (entryId: string) => {
                const moduleGraph = await collectModuleGraphFromServer(
                    server,
                    entryId,
                    context.buildRoot,
                );
                return extractConnectionIdsFromModuleGraph(entryId, moduleGraph, context.buildRoot);
            };
            const middleware = createDevServerMiddleware(
                bundler.build,
                loadModule,
                getBackendFunctions,
                getAllowedConnectionIds,
                auth,
                doAuthenticatedRequest,
                options.longPolling,
                context.buildRoot,
                log,
            );
            server.middlewares.use(middleware);
        },
    };
};
