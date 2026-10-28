// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile, rm } from '@dd/core/helpers/fs';
import type { GlobalContext, Logger, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import { createHash } from 'crypto';
import type { IncomingMessage } from 'http';
import path from 'path';
import type { build } from 'vite';

import {
    AUTH_GUIDANCE,
    getAuthenticatedRequest,
    MissingAuthenticationError,
    type DoAuthenticatedRequest,
} from '../auth';
import { extractExportedFunctions } from '../backend/ast-parsing/extract-backend-functions';
import { extractConnectionIdsFromModuleGraph } from '../backend/ast-parsing/extract-connection-ids-from-module-graph';
import { analyzeModuleScope } from '../backend/ast-parsing/module-scope';
import { createBackendStaticChecks } from '../backend/ast-parsing/run-backend-static-checks';
import { ensureProgram } from '../backend/ast-parsing/type-guards';
import {
    findInstalledBackendFunctionPackages,
    forgetBackendModuleOwners,
    getBackendModuleOwner,
    isBackendFunctionFile,
    isBackendSourceModule,
    isOutsideRoot,
    type BackendFunctionPackage,
    type InstalledBackendFunctionPackage,
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
    NODE_BACKEND_RUNTIME,
    NODE_BACKEND_RUNTIME_NODE_MAJOR,
    PLUGIN_NAME,
} from '../constants';
import { PARAMETERS_MODULE } from '../parameters/extract-parameters';
import { createTagSources, resolveTags } from '../tags';
import type { TagSource } from '../tags';
import type { AppsOptionsWithDefaults } from '../types';

import { normalizeViteModuleId } from './backend-module-graph-collector';
import { buildBackendFunctions } from './build-backend-functions';
import { buildAppPackage } from './build-package';
import {
    CSP_VIOLATION_LOGGER_ID,
    CSP_VIOLATION_LOGGER_ID_RE,
    CSP_VIOLATION_LOGGER_SOURCE,
    getCspViolationLoggerTags,
    RESOLVED_CSP_VIOLATION_LOGGER_ID,
} from './dev-server-csp-violations';
import { createAppCspMiddleware, SELF_SERVED_APP_TYPE } from './dev-server-csp';
import { collectModuleGraphFromServer } from './dev-server-module-graph';
import { createViteHostCheck } from './dev-server-request-guard';
import { createDevServerMiddleware } from './dev-server';
import { getLocalExecutionChildPath } from './local-execution-child-path';
import type { ChildProcessExecutor } from './local-execution-process';
import { createChildProcessExecutor, resolveViteModuleRunner } from './local-execution-process';
import { localExecutionResolutionContext } from './local-execution';
import { createParameterCollector } from './parameter-collector';
import { loadViteParseAst } from './vite-parse-ast';
import { assertSupportedVite } from './vite-version';

export type ViteBundler = {
    build: typeof build;
    defaultServerConditions: readonly string[];
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
export const APPS_DEV_CLIENT_PATH = path.join(__dirname, './apps-dev-client.mjs');
export const DEV_CLIENT_MODULE_ID = 'virtual:dd-apps-dev-client';
// The `\0` prefix is Vite's virtual-module convention, which most plugins' id filters skip.
export const DEV_CLIENT_RESOLVED_ID = `\0${DEV_CLIENT_MODULE_ID}`;
export const DEV_CLIENT_SRC = `/@id/${DEV_CLIENT_MODULE_ID}`;
export const DEV_CLIENT_RESOLVED_RE = new RegExp(`^${DEV_CLIENT_RESOLVED_ID}$`);
export const SSR_WARMUP_SETTING = 'environments.ssr.dev.preTransformRequests';

// The `\0` prefix is the bundler convention for "not a real file": Rollup and Rolldown both leave
// such modules out of sourcemaps, and Vite's own resolvers and loaders don't touch them.
// Between them goes a hash of the backend module's root-relative id, not the id itself: the
// proxy id can reach build outputs such as Vite's manifest, which shouldn't name backend files
// or depend on where the project is checked out. Bundlers name a chunk after its module's last
// path segment, so the id ends in a short one.
const FRONTEND_PROXY_ID_PREFIX = '\0dd-apps-backend-proxy:';
const FRONTEND_PROXY_ID_SUFFIX = '/proxy';
const FRONTEND_PROXY_ID_RE = new RegExp(`^${FRONTEND_PROXY_ID_PREFIX}`);

// Local execution runs on the developer's own Node; WebSocket is a default global from Node 22.
export const MIN_LOCAL_NODE_MAJOR = 22;

export function localNodeWarning(nodeVersion: string): string | undefined {
    const major = Number.parseInt(nodeVersion, 10);
    if (major < MIN_LOCAL_NODE_MAJOR) {
        return `Node ${nodeVersion} has no global WebSocket, which backend functions get on the ${NODE_BACKEND_RUNTIME}; use Node ${MIN_LOCAL_NODE_MAJOR} or later to run them locally.`;
    }
    if (major !== NODE_BACKEND_RUNTIME_NODE_MAJOR) {
        return `Your local Node version "${nodeVersion}" doesn't match the ${NODE_BACKEND_RUNTIME}'s Node version "${NODE_BACKEND_RUNTIME_NODE_MAJOR}", so backend functions may behave differently locally.`;
    }
    return undefined;
}

/**
 * Has the browser revalidate a requested backend function file, as it does the app's own modules.
 * Vite versions a dependency's module URLs with a `v=` query and serves those with a year-long
 * immutable cache, so after a dev-server restart the browser would keep calling through a
 * package's cached proxy without requesting it, and the new server would never register its
 * functions. Dropping the query from the request, not from the URLs Vite writes into importing
 * modules, makes Vite serve the file with `no-cache`.
 */
function revalidateBackendFunctionFile(req: IncomingMessage): void {
    if (req.method === 'GET' && req.url) {
        const [urlPath] = req.url.split(/[?#]/);
        if (BACKEND_FILE_RE.test(urlPath)) {
            req.url = req.url.replace(/([?&])v=[^&#]*(&?)/, (_, separator: string, rest: string) =>
                rest ? separator : '',
            );
        }
    }
}

/**
 * Logs, at info level, the backend functions packages contribute to the app's package. The
 * package's own manifest is the whole consent, so whoever builds the app should see what it ships.
 */
function logPackageBackendFunctions(
    functions: BackendFunction[],
    buildRoot: string,
    log: Logger,
): void {
    const namesByPackage = new Map<string, string[]>();
    for (const func of functions) {
        const owner = getBackendModuleOwner(func.absolutePath, buildRoot);
        if (owner.kind === 'backend-package') {
            const names = namesByPackage.get(owner.package.name) ?? [];
            namesByPackage.set(owner.package.name, [...names, func.name]);
        }
    }
    if (namesByPackage.size > 0) {
        const contributions = [...namesByPackage].map(
            ([name, names]) => `${name} (${names.join(', ')})`,
        );
        log.info(`Backend functions provided by packages: ${contributions.join('; ')}`);
    }
}

/**
 * Adds each package's root to the dev server's `server.fs.allow`, unless an entry already
 * covers it. Otherwise Vite only serves a file from a package linked outside the workspace once
 * this server has transformed a module importing it: after a restart, a browser revalidating a
 * linked package's backend file, imported from a module it still has cached, would be refused.
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

 * Dev (configureServer): reports the app CSP on HTML and worker responses, and registers
 * middleware for local backend function testing when auth credentials are available.
 */
export const getVitePlugin = ({
    bundler,
    context,
    options,
}: VitePluginOptions): PluginOptions['vite'] => {
    const log = context.getLogger(PLUGIN_NAME);
    const runStaticChecks = createBackendStaticChecks(log);
    const { auth } = context;

    context.inject({
        type: 'file',
        position: InjectPosition.MIDDLE,
        value: APPS_RUNTIME_PATH,
    });

    const { setBackendFunctions, getBackendFunctions } = createBackendFunctionRegistry();
    // What `@datadog/apps-frontend/parameters` resolves to in the current build,
    // so app source importing it through an alias can be caught.
    let parametersModuleId: string | undefined;
    const parameterCollector = createParameterCollector(
        () => context.buildRoot,
        () => parametersModuleId,
    );

    // Vite also invokes closeBundle when a dev server closes; configureServer marks the dev session
    // so its exit doesn't rebuild backend functions or replace the production package.
    let devServerActive = false;
    let isAppCspActive = false;
    let hasNoticedSsrWarmupOverride = false;
    let serverPreTransformRequests: boolean | undefined;
    let isBuild = false;
    // A build's proxy ids, each to the backend module it stands for.
    const frontendProxySources = new Map<string, string>();
    let backendPackages: InstalledBackendFunctionPackage[] = [];

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
                // Tests run with mock bundler versions.
                if (context.env !== 'test') {
                    assertSupportedVite(this, context.bundler.version);
                }
                isBuild = command === 'build';
                serverPreTransformRequests = userConfig.server?.preTransformRequests;
                // A restarted dev server shares this process: read the manifests afresh.
                forgetBackendModuleOwners();
                // Only the dev server pre-bundles dependencies or loads modules through SSR; the
                // nested backend builds configure their own resolution (see build-config.ts).
                if (command !== 'serve') {
                    backendPackages = [];
                    return { ssr: { noExternal: [...BACKEND_RUNTIME_PACKAGES] } };
                }

                // configResolved (where context.buildRoot is set) runs after this hook, so resolve
                // the root the same way Vite does.
                const root = path.resolve(userConfig.root ?? process.cwd());
                // Package roots must match the paths Vite serves, and Vite only resolves symlinks
                // in them when preserveSymlinks is off.
                const preserveSymlinks = userConfig.resolve?.preserveSymlinks ?? false;
                // A package the app imports without declaring it is found through the
                // optimizeDeps.exclude entry the README asks for, so it's configured like the rest.
                backendPackages = findInstalledBackendFunctionPackages(
                    root,
                    preserveSymlinks,
                    userConfig.optimizeDeps?.exclude ?? [],
                );
                // Every name an import can use: an npm alias too, or Vite would pre-bundle the
                // aliased package. Two installed copies of a package share its name.
                const backendPackageNames = [
                    ...new Set(backendPackages.flatMap((pkg) => pkg.installedAs)),
                ];
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
                        dedupe: [...BACKEND_RUNTIME_PACKAGES],
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
        // Unlike the config hook, it sees the SSR options merged with the defaults.
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
                if (source === DEV_CLIENT_MODULE_ID) {
                    return devServerActive && resolveOptions.ssr !== true
                        ? DEV_CLIENT_RESOLVED_ID
                        : null;
                }
                if (source === CSP_VIOLATION_LOGGER_ID) {
                    return RESOLVED_CSP_VIOLATION_LOGGER_ID;
                }

                // In a frontend build, each client-side import of a backend function file resolves
                // to a proxy module of its own (see load below). Under the backend file's id, the
                // stub would keep the sourcemaps earlier transforms attached to that file, whose
                // sourcesContent is the original source: Rolldown keeps the first map's sources
                // whatever later transforms return. The dev server keeps serving backend modules
                // under their own ids, where the transform below replaces them and edits to the
                // file still reach the browser. This costs every client-side import in a build one
                // extra resolution.
                if (isBuild && resolveOptions.ssr !== true) {
                    const resolved = await this.resolve(source, importer, {
                        ...resolveOptions,
                        skipSelf: true,
                    });
                    if (
                        !resolved ||
                        resolved.external ||
                        !isBackendFunctionFile(
                            resolved.id,
                            context.buildRoot,
                            context.bundler.outDir,
                        )
                    ) {
                        return resolved;
                    }
                    const relativeId = path
                        .relative(context.buildRoot, resolved.id)
                        .split(path.sep)
                        .join('/');
                    const key = createHash('sha256').update(relativeId).digest('hex');
                    frontendProxySources.set(key, resolved.id);
                    const proxyId = `${FRONTEND_PROXY_ID_PREFIX}${key}${FRONTEND_PROXY_ID_SUFFIX}`;
                    return { ...resolved, id: proxyId };
                }

                // Guard (not folded into each branch) so any future local-execution branch below
                // inherits it automatically: local execution's traversal is always SSR, so without
                // this a client-mode resolution could inherit the marker and leak real backend code.
                if (resolveOptions.ssr !== true) {
                    return null;
                }

                // The other half of the scoping: the store is only populated while a call's module
                // runner request is in flight (see local-execution-process.ts), so an unrelated SSR
                // resolution never inherits a marker from an earlier execution.
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
                // Classified without its query: an installed module's id carries Vite's `?v=`
                // cache key once the SSR environment has a deps optimizer.
                const resolvedPath = normalizeViteModuleId(resolved.id);
                if (!isBackendSourceModule(resolvedPath, context.buildRoot)) {
                    return resolved;
                }

                const suffixedId = resolved.id + LOCAL_EXECUTION_LOAD_SUFFIX;
                if (!BACKEND_FILE_RE.test(resolvedPath)) {
                    subgraphImporters?.add(suffixedId);
                }
                return { ...resolved, id: suffixedId };
            },
        },
        load: {
            // Ahead of other plugins' load hooks, which may claim any id.
            order: 'pre',
            filter: {
                id: {
                    include: [
                        DEV_CLIENT_RESOLVED_RE,
                        CSP_VIOLATION_LOGGER_ID_RE,
                        FRONTEND_PROXY_ID_RE,
                    ],
                },
            },
            async handler(id) {
                if (id === DEV_CLIENT_RESOLVED_ID) {
                    try {
                        return await readFile(APPS_DEV_CLIENT_PATH);
                    } catch (error: unknown) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        throw new Error(
                            `Framed backend calls won't carry their bundle, the dev client didn't load: ${errorMessage}`,
                        );
                    }
                }
                if (id === RESOLVED_CSP_VIOLATION_LOGGER_ID) {
                    return CSP_VIOLATION_LOGGER_SOURCE;
                }
                const sourceId = frontendProxySources.get(
                    id.slice(FRONTEND_PROXY_ID_PREFIX.length, -FRONTEND_PROXY_ID_SUFFIX.length),
                );
                if (sourceId === undefined) {
                    return null;
                }
                // Loading the backend module runs it through the app's own pipeline and then the
                // transform below, which registers its functions and returns the proxy stub. Only
                // that code joins the frontend graph: nothing imports the backend module itself,
                // so the bundler never renders it or its sourcemaps.
                const { code } = await this.load({ id: sourceId });
                return code;
            },
        },
        transform: {
            // Only an optimization: it can't express build-root-relative exclusions or a
            // package's opt-in.
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
                    // Local execution needs the real function body, not the proxy stub below — a call's module runner always fetches through the SSR environment, so this only fires for that legitimate path.
                    return null;
                }
                // Any other case (no query, a spoofed client-side import reusing the suffix, or an unrecognized query) falls through to the safe proxy-stub generation below. Strip the query first so it registers under the file's real (unsuffixed) relativePath/query-name, not a duplicate.
                const queryIndex = id.search(/[?#]/);
                const normalizedId = queryIndex === -1 ? id : id.slice(0, queryIndex);

                const ast = this.parse(code);
                const program = ensureProgram(ast, normalizedId);
                const scopeAnalysis = analyzeModuleScope(program);
                // Runs even for a file with zero exports, to catch a restricted global as soon as it's written.
                runStaticChecks(ast, normalizedId, scopeAnalysis);
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
                    return { code: '', map: { mappings: '' } };
                }

                const { functions, proxyCode } = buildProxyModule(
                    exportNames,
                    normalizedId,
                    context.buildRoot,
                );
                setBackendFunctions(normalizedId, functions);
                log.debug(`Generated proxy for ${normalizedId} with ${functions.length} export(s)`);

                // The stub doesn't correspond position-for-position to the code it replaces, which
                // `map: null` would claim: the dev server would then trace it back into the
                // original source and serve that alongside it. An empty mapping maps it to nothing.
                return { code: proxyCode, map: { mappings: '' } };
            },
        },
        async buildStart() {
            // A watch-mode rebuild must not inherit tags derived from the previous build's code.
            buildTagSources = createBuildTagSources();
            parametersModuleId = undefined;
            if (options.parameters === undefined) {
                // Resolved from the root, as app source would. An app without
                // the SDK, or with a version that predates parameters, doesn't
                // resolve it, and can't import it through an alias either.
                try {
                    const resolved = await this.resolve(
                        PARAMETERS_MODULE,
                        path.join(context.buildRoot, 'index.html'),
                        { skipSelf: true },
                    );
                    parametersModuleId = resolved && !resolved.external ? resolved.id : undefined;
                } catch {
                    parametersModuleId = undefined;
                }
            }
        },
        // Reads parameter declarations from compiled app modules before bundling
        // can inline or tree-shake them. Production builds only, like the
        // backend module-graph collector.
        async moduleParsed(moduleInfo) {
            // An explicit declaration replaces discovery, including for code the
            // build could not read.
            if (options.parameters !== undefined) {
                return;
            }
            // Parse rather than read moduleInfo.ast, which Rolldown does not provide.
            await parameterCollector.readModule(
                moduleInfo.id,
                moduleInfo.code,
                [...moduleInfo.importedIds, ...moduleInfo.dynamicallyImportedIds],
                (code) => ensureProgram(this.parse(code), moduleInfo.id),
                async (specifier) => {
                    const resolved = await this.resolve(specifier, moduleInfo.id, {
                        skipSelf: true,
                    });
                    return resolved?.id;
                },
            );
        },
        buildEnd() {
            // A watch rebuild only re-parses changed modules.
            parameterCollector.retainModules(this.getModuleIds());
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
            // An explicit option overrides discovery. Otherwise the code is the
            // only definition, so finding nothing clears an earlier declaration.
            const parameters = options.parameters ?? parameterCollector.resolve();
            if (devServerActive) {
                log.debug('Skipping app packaging: dev server session.');
                return;
            }
            let backendOutDir: string | undefined;
            let backendOutputs = new Map<string, string>();
            let backendFunctions = getBackendFunctions();
            logPackageBackendFunctions(backendFunctions, context.buildRoot, log);
            if (backendFunctions.length > 0) {
                const result = await buildBackendFunctions(
                    bundler.build,
                    backendFunctions,
                    context.buildRoot,
                    log,
                    runStaticChecks,
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
                    parameters,
                });
            } finally {
                if (backendOutDir) {
                    await rm(backendOutDir);
                }
            }
        },
        transformIndexHtml: {
            // Before Vite's own HTML rewrite, which prefixes the dev client's src with the configured `base`.
            order: 'pre',
            handler(_html, ctx) {
                if (!ctx.server) {
                    return [];
                }
                return [
                    ...getCspViolationLoggerTags(isAppCspActive),
                    {
                        tag: 'script',
                        attrs: { type: 'module', src: DEV_CLIENT_SRC },
                        injectTo: 'head-prepend',
                    },
                ];
            },
        },
        configureServer(server) {
            devServerActive = true;
            // Vitest serves its own UI and browser-mode pages, with inline scripts, from this server.
            isAppCspActive = !process.env.VITEST && server.config.appType !== SELF_SERVED_APP_TYPE;
            if (isAppCspActive) {
                const appCspMiddleware = createAppCspMiddleware(server.config);
                server.middlewares.use(appCspMiddleware);
            }
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
            const runsLocally = doAuthenticatedRequest && server.config.mode !== DEV_VERIFY_MODE;
            const childEntryPath = getLocalExecutionChildPath();
            const moduleRunnerPath = resolveViteModuleRunner(context.buildRoot);
            const executeLocally: ChildProcessExecutor | undefined = runsLocally
                ? createChildProcessExecutor({
                      invokeChannel: server.environments.ssr.hot,
                      projectRoot: context.buildRoot,
                      childEntryPath,
                      moduleRunnerPath,
                      readRoots: server.config.server.fs?.allow ?? [],
                      denyPatterns: server.config.server.fs?.deny ?? [],
                      restrictModuleLoads: server.config.server.fs?.strict !== false,
                      resolveModule: async (url, importer) => {
                          const resolved = await server.environments.ssr.pluginContainer.resolveId(
                              url,
                              importer,
                          );
                          return resolved?.id;
                      },
                      log,
                  })
                : undefined;
            if (executeLocally) {
                // A restart starts the new server before closing this one, so each server ends only its own calls.
                const closeServer = server.close.bind(server);
                server.close = async () => {
                    executeLocally.close();
                    await closeServer();
                };
                const nodeWarning = localNodeWarning(process.versions.node);
                if (nodeWarning) {
                    log.warn(nodeWarning);
                }
                // Started here so an unusable Vite is reported at startup; each execution reuses
                // this load, or retries it after a failure.
                loadViteParseAst().catch((error: unknown) => {
                    const reason = error instanceof Error ? error.message : String(error);
                    log.warn(`Local execution can't parse backend modules: ${reason}`);
                });
            }

            // Safe to call before a call's process loads anything: collectModuleGraphFromServer
            // primes each node itself via `transformRequest`, since `moduleParsed` (production's
            // mechanism) is Rollup-build-only and never fires on a real dev server.
            const getAllowedConnectionIds = async (entryId: string) => {
                const parseAst = await loadViteParseAst();
                const moduleGraph = await collectModuleGraphFromServer(
                    server,
                    entryId,
                    context.buildRoot,
                    runStaticChecks,
                    parseAst,
                );
                return extractConnectionIdsFromModuleGraph(entryId, moduleGraph, context.buildRoot);
            };
            const isHostAllowed = createViteHostCheck(server.config);
            const middleware = createDevServerMiddleware(
                bundler.build,
                getBackendFunctions,
                getAllowedConnectionIds,
                auth,
                doAuthenticatedRequest,
                options.longPolling,
                context.buildRoot,
                log,
                runStaticChecks,
                server.config.mode,
                isHostAllowed,
                bundler.defaultServerConditions,
                executeLocally,
            );
            server.middlewares.use((req, res, next) => {
                revalidateBackendFunctionFile(req);
                middleware(req, res, next);
            });
        },
    };
};
