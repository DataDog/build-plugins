// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GlobalContext, Logger, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import path from 'path';
import type { build, ViteDevServer } from 'vite';

import {
    AUTH_GUIDANCE,
    getAuthenticatedRequest,
    MissingAuthenticationError,
    type DoAuthenticatedRequest,
} from '../auth';
import { extractExportedFunctions } from '../backend/ast-parsing/extract-backend-functions';
import { extractConnectionIdsFromModuleGraph } from '../backend/ast-parsing/extract-connection-ids-from-module-graph';
import { analyzeModuleScope } from '../backend/ast-parsing/module-scope';
import { runBackendStaticChecks } from '../backend/ast-parsing/run-backend-static-checks';
import { ensureProgram } from '../backend/ast-parsing/type-guards';
import {
    findInstalledBackendFunctionPackages,
    findPackageBackendFunctionFiles,
    isBackendFunctionFile,
    isBackendSourceModule,
    isOutsideRoot,
    type BackendFunctionPackage,
} from '../backend/backend-sources';
import { encodeQueryName } from '../backend/encodeQueryName';
import { generateProxyModule } from '../backend/proxy-codegen';
import { BACKEND_RUNTIME_PACKAGES } from '../backend/shared';
import type { BackendFunction } from '../backend/types';
import {
    BACKEND_FILE_RE,
    BACKEND_FILE_WITH_QUERY_RE,
    DEV_VERIFY_MODE,
    LOCAL_EXECUTION_LOAD_SUFFIX,
    PLUGIN_NAME,
} from '../constants';
import { createTagSources, resolveTags } from '../tags';
import type { TagSource } from '../tags';
import type { AppsOptionsWithDefaults } from '../types';

import { buildBackendFunctions } from './build-backend-functions';
import { buildAppPackage } from './build-package';
import { collectModuleGraphFromServer } from './dev-server-module-graph';
import { createDevServerMiddleware } from './dev-server';
import { localExecutionResolutionContext } from './local-execution';
import {
    exemptFetchFromBlockedScope,
    exemptPluginContainerFromBlockedScope,
    GRACEFUL_FS_UNGUARDED_WARNING,
    gracefulFsPredatesGuards,
    installGuards,
} from './network-guard';
import { loadViteParseAst } from './vite-parse-ast';

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
export const SSR_WARMUP_SETTING = 'environments.ssr.dev.preTransformRequests';

/**
 * Registers every backend function the given packages ship by running each of their backend
 * function files through the transform, the same way the browser's first request would. The SSR
 * environment's, the one local execution loads them through; without the local-execution suffix
 * the transform still registers the file and returns its proxy. A file that fails is logged, not
 * fatal: the browser's request reports it too.
 */
async function registerPackageBackendFunctions(
    server: ViteDevServer,
    packages: BackendFunctionPackage[],
    log: Logger,
): Promise<void> {
    // Vite 5 has no environment API.
    const transformRequest = server.environments?.ssr
        ? (file: string) => server.environments.ssr.transformRequest(file)
        : (file: string) => server.transformRequest(file, { ssr: true });
    const register = async (file: string) => {
        try {
            await transformRequest(file);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log.warn(`Could not register the backend functions in ${file}: ${reason}`);
        }
    };
    await Promise.all(
        packages.map(async (pkg) => {
            let files: string[];
            try {
                files = findPackageBackendFunctionFiles(pkg);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                log.warn(`Could not list the backend functions of "${pkg.name}": ${reason}`);
                return;
            }
            await Promise.all(files.map(register));
        }),
    );
}

/**
 * Adds each package's real root to the dev server's `server.fs.allow`, unless an entry already
 * covers it. Otherwise Vite only loads a file from a package linked outside the workspace once
 * something has imported it, so after a restart local execution fails on a function the browser
 * still calls through its cached proxy.
 */
function allowPackageRoots(allow: string[], packages: BackendFunctionPackage[]): void {
    for (const { root } of packages) {
        // Vite's entries and the paths it checks against them use forward slashes.
        const vitePath = path.sep === '\\' ? root.split(path.sep).join('/') : root;
        if (!allow.some((dir) => !isOutsideRoot(path.relative(dir, vitePath)))) {
            allow.push(vitePath);
        }
    }
}

/**
 * Returns the Vite-specific plugin hooks for the apps plugin.
 *
 * Transform: discovers backend exports and connection allowlists, registers
 * backend functions, and replaces each backend module with its frontend proxy.
 *
 * Production (closeBundle): builds backend functions (if any) then writes the
 * deployable package without resolving authentication or performing requests.

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

    // Vite 6 invokes closeBundle when a dev server's plugin container closes,
    // not only for production builds. configureServer only runs for dev
    // servers, so use it to mark the session and skip packaging there — a
    // dev exit must not rebuild backend functions or replace the production
    // package with dev-session-derived output.
    let devServerActive = false;
    let hasNoticedSsrWarmupOverride = false;
    let serverPreTransformRequests: boolean | undefined;
    let backendPackages: BackendFunctionPackage[] = [];

    // Tag sources for the current build. Replaced (never mutated) per build, since a watch-mode
    // rebuild can start before the previous closeBundle finishes.
    const createBuildTagSources = () => createTagSources({ options, log });
    // Created in buildStart, so each build gets its own sources and authored-tag warnings fire
    // once per build rather than also at plugin init.
    let buildTagSources: TagSource[] = [];

    return {
        config: {
            // After other plugins' config hooks, so it sees a server.preTransformRequests they set.
            order: 'post',
            handler(userConfig, { command }) {
                serverPreTransformRequests = userConfig.server?.preTransformRequests;
                // These SDKs ship ESM-only, but ssrLoadModule externalizes node_modules with a plain
                // require(), which throws "Cannot use import statement outside a module";
                // ssr.noExternal forces Vite's SSR transform instead.
                // Only the dev server pre-bundles dependencies or loads modules through SSR; the
                // nested backend builds configure their own resolution (see build-config.ts).
                if (command !== 'serve') {
                    return { ssr: { noExternal: BACKEND_RUNTIME_PACKAGES } };
                }

                // configResolved (where context.buildRoot is set) runs after this hook, so resolve
                // the root the same way Vite does.
                const root = path.resolve(userConfig.root ?? process.cwd());
                backendPackages = findInstalledBackendFunctionPackages(root);
                // Two installed copies of a package share its name.
                const installedPackageNames = backendPackages.map((pkg) => pkg.name);
                const backendPackageNames = [...new Set(installedPackageNames)];
                // Info, not debug: the package's own manifest is the whole consent, so the app's
                // developer should see which packages it trusts to add backend functions.
                if (backendPackageNames.length > 0) {
                    log.info(
                        `Packages providing backend functions, kept out of dependency pre-bundling: ${backendPackageNames.join(', ')}`,
                    );
                }
                return {
                    // A package providing backend functions needs the same, so local execution
                    // runs its real modules (and its self-referencing imports) through this plugin.
                    ssr: {
                        noExternal: [...BACKEND_RUNTIME_PACKAGES, ...backendPackageNames],
                    },
                    // Pre-bundling would inline a package's backend files into a browser chunk
                    // where the transform below never sees them, shipping their real body instead
                    // of the proxy. Excluding the package also keeps it external inside any other
                    // pre-bundled dependency that imports it.
                    optimizeDeps: { exclude: backendPackageNames },
                    // A backend runtime singleton must be the app's own copy, the one the backend
                    // entry initializes during local execution, even when a package providing
                    // backend functions is linked from somewhere that has its own copy installed.
                    resolve: {
                        dedupe: BACKEND_RUNTIME_PACKAGES,
                    },
                };
            },
        },
        configResolved(config) {
            if (config.command === 'serve') {
                // Mutates the resolved list: that extends Vite's default (or the user's list)
                // without replacing it or importing vite.
                allowPackageRoots(config.server.fs.allow, backendPackages);
            }
        },
        // Only Vite 6+ calls this hook, and only it sees the SSR options merged with the defaults.
        configEnvironment(name, environmentOptions, { command, isPreview }) {
            if (name !== 'ssr' || command !== 'serve' || isPreview) {
                return undefined;
            }
            // Vite uses server.preTransformRequests only when the environment leaves this unset.
            const isSsrWarmupOn =
                environmentOptions.dev?.preTransformRequests ?? serverPreTransformRequests;
            if (isSsrWarmupOn && !hasNoticedSsrWarmupOverride) {
                hasNoticedSsrWarmupOverride = true;
                log.warn(
                    `Turning off SSR import warmup (${SSR_WARMUP_SETTING}) so edited backend code runs on the next local execution.`,
                );
            }
            // Warming SSR imports re-caches modules that local execution un-caches to re-run.
            return { dev: { preTransformRequests: false } };
        },
        // Propagates LOCAL_EXECUTION_LOAD_SUFFIX through the backend-file dependency graph so a
        // nested `.backend.ts` import isn't replaced with the frontend proxy stub. Every subgraph
        // module gets its own suffixed id, since Vite otherwise shares one cached id across callers.
        resolveId: {
            // Must run before Vite's built-in resolver ('pre'): a plain relative specifier like
            // `./other.backend` is otherwise fully resolved by Vite's own filesystem resolution
            // first, short-circuiting the hook chain before this plugin ever sees it.
            order: 'pre',
            async handler(source, importer, resolveOptions) {
                // Top-level guard (not folded into each branch) so any future branch added below
                // inherits it automatically: local execution's traversal is always SSR, so without
                // this a client-mode resolution could inherit the marker and leak real backend code.
                if (resolveOptions.ssr !== true) {
                    return null;
                }

                // The other half of the scoping: the store is only populated while a local
                // execution's own loadModule call is in flight (see configureServer), so an
                // unrelated SSR resolution never inherits a marker from an earlier execution.
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

                if (resolved.id.endsWith(LOCAL_EXECUTION_LOAD_SUFFIX)) {
                    return resolved;
                }

                // Only backend source (app code or an opted-in package's code, which is kept out of
                // optimizeDeps) gets a distinct local-execution identity — any other SDK/package
                // import must resolve to the same module Vite otherwise caches for it, since an
                // unrecognized query on a node_modules id can break Vite's optimizeDeps handling.
                if (!isBackendSourceModule(resolved.id, context.buildRoot)) {
                    return resolved;
                }

                const suffixedId = resolved.id + LOCAL_EXECUTION_LOAD_SUFFIX;
                if (!BACKEND_FILE_RE.test(resolved.id)) {
                    subgraphImporters?.add(suffixedId);
                }
                return { ...resolved, id: suffixedId };
            },
        },
        transform: {
            // Only an optimization: Vite < 6.3 ignores it, and it can't express build-root-relative
            // exclusions or a package's opt-in.
            filter: { id: { include: [BACKEND_FILE_WITH_QUERY_RE] } },
            // For each .backend.* file, parse its named exports, register
            // them as backend functions, and replace the module with a
            // frontend proxy that calls executeBackendFunction at runtime.
            handler(code, id, transformOptions) {
                // A `.backend.*` name alone isn't enough: only the app's own files (outside
                // package-manager dirs and the outDir) and those of packages that opted in become
                // functions. Anything else stays an ordinary module.
                const shouldTransform = isBackendFunctionFile(
                    id,
                    context.buildRoot,
                    context.bundler.outDir,
                );
                if (!shouldTransform) {
                    return null;
                }
                if (id.endsWith(LOCAL_EXECUTION_LOAD_SUFFIX) && transformOptions?.ssr) {
                    // Local execution needs the real function body, not the proxy stub below — real loads always go through ssrLoadModule, which runs in SSR, so this only fires for that legitimate path.
                    return null;
                }
                // Any other case (no query, a spoofed client-side import reusing the suffix, or an unrecognized query) falls through to the safe proxy-stub generation below. Strip the query first so it registers under the file's real (unsuffixed) relativePath/query-name, not a duplicate.
                const queryIndex = id.search(/[?#]/);
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
        buildStart() {
            // A watch-mode rebuild must not inherit tags derived from the previous build's code.
            buildTagSources = createBuildTagSources();
        },
        generateBundle: {
            // After other plugins have finished rewriting chunk code.
            order: 'post',
            handler(_outputOptions, bundle) {
                for (const output of Object.values(bundle)) {
                    if (output.type !== 'chunk') {
                        continue;
                    }
                    const chunk = { fileName: output.fileName, code: output.code };
                    for (const source of buildTagSources) {
                        source.readChunk?.(chunk);
                    }
                }
            },
        },
        async closeBundle() {
            // Taken before any await, so the next watch-mode build can't change what this one packages.
            const tags = resolveTags(buildTagSources);
            if (devServerActive) {
                log.debug('Skipping app packaging: dev server session.');
                return;
            }
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
                await buildAppPackage({
                    backendOutputs,
                    backendFunctions,
                    context,
                    options,
                    tags,
                });
            } finally {
                if (backendOutDir) {
                    await rm(backendOutDir);
                }
            }
        },
        configureServer(server) {
            devServerActive = true;
            if (server.environments?.ssr?.config.dev.preTransformRequests) {
                log.warn(
                    `SSR import warmup (${SSR_WARMUP_SETTING}) is on, so edited backend code may not run until the dev server restarts.`,
                );
            }
            let doAuthenticatedRequest: DoAuthenticatedRequest | undefined;
            try {
                doAuthenticatedRequest = getAuthenticatedRequest();
            } catch (error) {
                if (!(error instanceof MissingAuthenticationError)) {
                    throw error;
                }
                log.warn(
                    `No authentication configured. Both the /__dd/executeAction and /__dd/executeActionViaCloud endpoints will be unavailable. ${AUTH_GUIDANCE}`,
                );
            }
            // Without auth nothing executes, and dev-verify sends every execution to the cloud.
            if (doAuthenticatedRequest && server.config.mode !== DEV_VERIFY_MODE) {
                // As early as a dev server allows, so fewer fs wrappers (e.g. graceful-fs clones)
                // predate it. A failure must not stop the server: each execution installs again, failing closed.
                try {
                    installGuards();
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    log.warn(
                        `Could not install the backend function sandbox guards yet: ${reason}`,
                    );
                }
                if (gracefulFsPredatesGuards()) {
                    log.warn(GRACEFUL_FS_UNGUARDED_WARNING);
                }
                // Started here so an unusable Vite is reported at startup; each execution reuses
                // this load, or retries it after a failure.
                loadViteParseAst().catch((error: unknown) => {
                    const reason = error instanceof Error ? error.message : String(error);
                    log.warn(`Local execution can't parse backend modules: ${reason}`);
                });
                const ssrEnvironment = server.environments?.ssr;
                if (ssrEnvironment) {
                    const fetchModule = ssrEnvironment.fetchModule.bind(ssrEnvironment);
                    ssrEnvironment.fetchModule = exemptFetchFromBlockedScope(fetchModule);
                } else if (server.pluginContainer) {
                    exemptPluginContainerFromBlockedScope(server.pluginContainer);
                }
            }

            const loadModule = server.ssrLoadModule.bind(server);
            // Safe to call before `loadModule` runs anything: collectModuleGraphFromServer primes
            // each node itself via `transformRequest`, since `moduleParsed` (production's
            // mechanism) is Rollup-build-only and never fires on a real dev server.
            const getAllowedConnectionIds = async (entryId: string) => {
                const parseAst = await loadViteParseAst();
                const moduleGraph = await collectModuleGraphFromServer(
                    server,
                    entryId,
                    context.buildRoot,
                    log,
                    parseAst,
                );
                return extractConnectionIdsFromModuleGraph(entryId, moduleGraph, context.buildRoot);
            };
            // A browser keeps an opted-in package's proxy modules across dev-server restarts:
            // Vite serves excluded dependencies with a `?v=` query, as immutable. The transform
            // would then never run in this server and leave their functions unregistered, so
            // every backend function file those packages ship is registered at startup, and
            // requests wait for that.
            const packageFunctionsRegistered =
                backendPackages.length > 0
                    ? registerPackageBackendFunctions(server, backendPackages, log)
                    : undefined;
            const middleware = createDevServerMiddleware(
                bundler.build,
                loadModule,
                packageFunctionsRegistered
                    ? () => packageFunctionsRegistered.then(getBackendFunctions)
                    : getBackendFunctions,
                getAllowedConnectionIds,
                auth,
                doAuthenticatedRequest,
                options.longPolling,
                context.buildRoot,
                log,
                server.config.mode,
            );
            server.middlewares.use(middleware);
        },
    };
};
