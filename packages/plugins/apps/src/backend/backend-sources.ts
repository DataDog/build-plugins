// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, readJsonSync } from '@dd/core/helpers/fs';
import fs from 'fs';
import path from 'path';

import { BACKEND_CODE_EXTENSIONS, BACKEND_FILE_WITH_QUERY_RE } from '../constants';

/**
 * Decides which modules belong to an app's backend: the app's own source, plus the source of any
 * installed package that opts in from its `package.json`:
 *
 *     "datadogApps": { "backendFunctions": true }
 *
 * This is the one answer the transform (which files become functions), the static checks and
 * connection-ID traversal (which modules are checked like app code), the dev server and the build
 * all ask. A dependency that hasn't opted in can never add a function through its file names.
 */

/** An installed package that opted in to providing backend functions. */
export interface BackendFunctionPackage {
    /** The package's own manifest `name`, used when it imports itself by package specifier. */
    name: string;
    /** Real (symlink-resolved) path of the package directory, the same form Vite uses for module ids. */
    root: string;
}

/** A package that didn't opt in, identified for error messages. */
export interface OrdinaryPackage {
    name: string;
    root: string;
}

/** Who a module's source belongs to, as far as backend functions are concerned. */
export type BackendModuleOwner =
    /**
     * The app's own source: inside the build root, outside package-manager directories. That
     * includes a workspace package that lives inside the root, whatever its manifest says.
     */
    | { kind: 'app' }
    /** Source of an installed or linked package that opted in; treated exactly like app source. */
    | { kind: 'backend-package'; package: BackendFunctionPackage }
    /**
     * An installed package (under a package-manager directory) that didn't opt in. Its modules,
     * `.backend.*` included, stay ordinary modules.
     */
    | { kind: 'dependency'; package?: OrdinaryPackage }
    /**
     * A package outside the build root, outside package-manager directories (a linked workspace
     * package, `npm link`, a `file:` dependency) that didn't opt in. Like any linked workspace file,
     * its `.backend.*` files are still proxied, but never analyzed as backend source, so the build
     * fails closed instead of deploying them.
     */
    | { kind: 'linked-package'; package: OrdinaryPackage }
    /** Outside the build root and not part of any package (e.g. a monorepo sibling folder). */
    | { kind: 'outside-app' };

export const PACKAGE_MANAGER_DIRS = new Set(['node_modules', '.yarn']);

// Split on both separators: Vite ids use forward slashes even on Windows.
const splitPath = (filePath: string) => filePath.split(/[\\/]/);

export function isPackageManagerModule(modulePath: string): boolean {
    return splitPath(modulePath).some((segment) => PACKAGE_MANAGER_DIRS.has(segment));
}

// A `..`-prefixed directory name like `..gen` is still inside the root.
export function isOutsideRoot(relativePath: string): boolean {
    return (
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    );
}

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const APP_DEPENDENCY_FIELDS = [...DEPENDENCY_FIELDS, 'devDependencies'] as const;

type PackageManifest = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifest(manifestPath: string): PackageManifest | undefined {
    if (!existsSync(manifestPath)) {
        return undefined;
    }
    try {
        const manifest: unknown = readJsonSync(manifestPath);
        return isRecord(manifest) ? manifest : undefined;
    } catch {
        // An unreadable or malformed manifest can't opt anything in.
        return undefined;
    }
}

function providesBackendFunctions(manifest: PackageManifest): boolean {
    const appsField = manifest.datadogApps;
    return isRecord(appsField) && appsField.backendFunctions === true;
}

function isWithin(parent: string, child: string): boolean {
    return !isOutsideRoot(path.relative(parent, child));
}

interface OwningPackage {
    root: string;
    name: string;
    manifest: PackageManifest;
}

// Owners are cached per directory for the process: classification runs for every module the
// bundler sees, and installed manifests don't change without restarting the dev server.
const owningPackageByDir = new Map<string, OwningPackage | undefined>();

/**
 * The installed package a file under `node_modules` belongs to: the directory right after the
 * last `node_modules` segment (two for a scoped name), the way Node resolves it. A named
 * `package.json` deeper inside, like `preact/hooks/package.json`, is part of that package and
 * doesn't override its opt-in.
 */
function findInstalledPackage(filePath: string): { root: string; dirName: string } | undefined {
    const segments = splitPath(filePath);
    const nodeModulesIndex = segments.lastIndexOf('node_modules');
    if (nodeModulesIndex === -1) {
        return undefined;
    }
    const nameLength = segments[nodeModulesIndex + 1]?.startsWith('@') ? 2 : 1;
    const rootEnd = nodeModulesIndex + 1 + nameLength;
    // A file directly inside `node_modules` (or `node_modules/@scope`) belongs to no package.
    if (rootEnd >= segments.length) {
        return undefined;
    }
    return {
        root: segments.slice(0, rootEnd).join(path.sep) || path.sep,
        dirName: segments.slice(nodeModulesIndex + 1, rootEnd).join('/'),
    };
}

/**
 * The nearest enclosing `package.json` that has a `name`, for a file outside `node_modules`
 * (nameless ones, like a `dist/package.json` that only sets `"type"`, don't define a package).
 * Never climbs out of a package-manager directory, so a stray file inside one can't be claimed by
 * the app's own manifest further up.
 */
function findNearestNamedPackage(dir: string): OwningPackage | undefined {
    if (owningPackageByDir.has(dir)) {
        return owningPackageByDir.get(dir);
    }
    let owner: OwningPackage | undefined;
    if (!PACKAGE_MANAGER_DIRS.has(path.basename(dir))) {
        const manifest = readManifest(path.join(dir, 'package.json'));
        const parent = path.dirname(dir);
        if (manifest && typeof manifest.name === 'string') {
            owner = { root: dir, name: manifest.name, manifest };
        } else if (parent !== dir) {
            owner = findNearestNamedPackage(parent);
        }
    }
    owningPackageByDir.set(dir, owner);
    return owner;
}

function findOwningPackage(filePath: string): OwningPackage | undefined {
    const installed = findInstalledPackage(filePath);
    if (!installed) {
        return findNearestNamedPackage(path.dirname(filePath));
    }
    const { root, dirName } = installed;
    if (!owningPackageByDir.has(root)) {
        const manifest = readManifest(path.join(root, 'package.json'));
        const name = typeof manifest?.name === 'string' ? manifest.name : dirName;
        owningPackageByDir.set(root, manifest ? { root, name, manifest } : undefined);
    }
    return owningPackageByDir.get(root);
}

/**
 * Classifies a module id (an absolute file path, query already stripped) relative to the app at
 * `buildRoot`. Source inside the build root is always the app's, even under a nested package.json;
 * only modules reached through a package manager, or living outside the root, consult the owning
 * package's opt-in.
 *
 * Any spelling of the path classifies the same: a Vite id with forward slashes on Windows, or one
 * with `..` or repeated separators. A returned package root uses the platform's separators.
 */
export function getBackendModuleOwner(moduleId: string, buildRoot: string): BackendModuleOwner {
    const modulePath = path.normalize(moduleId);
    const root = path.resolve(buildRoot);
    const insideRoot = isWithin(root, modulePath);
    if (insideRoot && !isPackageManagerModule(path.relative(root, modulePath))) {
        return { kind: 'app' };
    }

    const underPackageManager = isPackageManagerModule(modulePath);
    const owner = findOwningPackage(modulePath);
    // A manifest enclosing the build root is the app's own (or its workspace's), never a dependency.
    if (owner && !isWithin(owner.root, root)) {
        const pkg = { name: owner.name, root: owner.root };
        if (providesBackendFunctions(owner.manifest)) {
            return { kind: 'backend-package', package: pkg };
        }
        return underPackageManager
            ? { kind: 'dependency', package: pkg }
            : { kind: 'linked-package', package: pkg };
    }

    return insideRoot || underPackageManager ? { kind: 'dependency' } : { kind: 'outside-app' };
}

/**
 * Explains why a backend function file isn't analyzable backend source, when it belongs to a
 * package that could opt in. Used to make fail-closed errors actionable.
 */
export function explainExcludedBackendFile(
    moduleId: string,
    buildRoot: string,
): string | undefined {
    const owner = getBackendModuleOwner(moduleId, buildRoot);
    const pkg =
        owner.kind === 'linked-package' || owner.kind === 'dependency' ? owner.package : undefined;
    if (!pkg) {
        return undefined;
    }
    const { name, root } = pkg;
    return (
        `${moduleId} belongs to the package "${name}" (${root}), which doesn't provide backend ` +
        `functions. Add "datadogApps": { "backendFunctions": true } to its package.json, or move ` +
        `the file into the app.`
    );
}

/** The package name a bare import specifier refers to, or undefined for a relative, absolute or URL-like one. */
function getPackageName(specifier: string): string | undefined {
    if (/^[./\\]/.test(specifier) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) {
        return undefined;
    }
    const segments = specifier.split('/');
    const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
    return name || undefined;
}

/**
 * Whether bare `specifier`, imported from module `importerId`, reaches a package that provides
 * backend functions: the importer's own package (a self-reference) or an installed one.
 */
export function importsBackendFunctionPackage(
    specifier: string,
    importerId: string,
    buildRoot: string,
): boolean {
    const name = getPackageName(specifier);
    if (!name) {
        return false;
    }
    const importerOwner = getBackendModuleOwner(importerId, buildRoot);
    if (importerOwner.kind === 'backend-package' && importerOwner.package.name === name) {
        return true;
    }
    const packageDir = locateInstalledPackage(name, path.dirname(importerId));
    const manifest = packageDir ? readManifest(path.join(packageDir, 'package.json')) : undefined;
    return manifest !== undefined && providesBackendFunctions(manifest);
}

/**
 * Whether a module is backend source the plugin analyzes like app code: traversed for connection
 * IDs, run through the static checks, and given its own local-execution identity in the dev server.
 */
export function isBackendSourceModule(moduleId: string, buildRoot: string): boolean {
    if (!BACKEND_CODE_EXTENSIONS.some((extension) => moduleId.endsWith(extension))) {
        return false;
    }
    const owner = getBackendModuleOwner(moduleId, buildRoot);
    return owner.kind === 'app' || owner.kind === 'backend-package';
}

const toPosixPath = (filePath: string) => filePath.replace(/\\/g, '/');

const isWithinDirectory = (directory: string, filePath: string): boolean => {
    const relativePath = path.posix.relative(directory, filePath);
    return (
        relativePath !== '..' &&
        !relativePath.startsWith('../') &&
        !path.posix.isAbsolute(relativePath)
    );
};

/**
 * Whether a module id (as a bundler hands it to a transform, query included) is a backend function
 * file: a `.backend.*` module that the frontend receives as a proxy and that is registered, bundled
 * and deployed per exported function. That's any such file of an opted-in package, wherever it's
 * installed, plus the app's own outside package-manager directories and the bundler's `outDir`.
 */
export function isBackendFunctionFile(id: string, buildRoot: string, outDir: string): boolean {
    if (!BACKEND_FILE_WITH_QUERY_RE.test(id)) {
        return false;
    }

    const [idWithoutQuery] = id.split(/[?#]/);
    const filePath = toPosixPath(idWithoutQuery).replace(/^\0/, '');
    // Virtual ids aren't on disk, so on-disk exclusions don't apply; resolving them would depend on cwd.
    if (!path.posix.isAbsolute(filePath) && !path.win32.isAbsolute(filePath)) {
        return true;
    }

    // An opted-in package's files are functions even under node_modules or its own dist/.
    const owner = getBackendModuleOwner(filePath, buildRoot);
    if (owner.kind === 'backend-package') {
        return true;
    }

    const posixBuildRoot = toPosixPath(buildRoot);
    // Outside the build root the full path decides, so a hoisted package beside an app under
    // node_modules stays excluded while a linked workspace file is still proxied.
    const isInsideBuildRoot = isWithinDirectory(posixBuildRoot, filePath);
    const pathToClassify = isInsideBuildRoot
        ? path.posix.relative(posixBuildRoot, filePath)
        : filePath;
    const segments = pathToClassify.split('/');
    if (segments.some((segment) => PACKAGE_MANAGER_DIRS.has(segment))) {
        return false;
    }

    // An outDir at or above the build root (e.g. `build.outDir: '.'`) must not exclude app files.
    const posixOutDir = toPosixPath(outDir);
    const outDirContainsBuildRoot = isWithinDirectory(posixOutDir, posixBuildRoot);
    return outDirContainsBuildRoot || !isWithinDirectory(posixOutDir, filePath);
}

function findNearestManifestDir(fromDir: string): string | undefined {
    let dir = path.resolve(fromDir);
    while (true) {
        if (existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

/** Locates an installed dependency the way Node does: `node_modules/<name>` in each ancestor directory. */
function locateInstalledPackage(name: string, fromDir: string): string | undefined {
    let dir = fromDir;
    while (true) {
        const candidate = path.join(dir, 'node_modules', name);
        if (existsSync(path.join(candidate, 'package.json'))) {
            return fs.realpathSync(candidate);
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

function getDependencyNames(
    manifest: PackageManifest,
    fields: ReadonlyArray<(typeof APP_DEPENDENCY_FIELDS)[number]>,
): string[] {
    return fields.flatMap((field) => {
        const dependencies = manifest[field];
        return isRecord(dependencies) ? Object.keys(dependencies) : [];
    });
}

export interface InstalledBackendFunctionPackage extends BackendFunctionPackage {
    /** Every bare specifier that reaches this package: its manifest name plus any alias it's installed under. */
    importNames: string[];
}

/**
 * Lists every opted-in package installed in the app's dependency tree (direct or transitive), so
 * dev-server configuration that needs package names up front, like dependency pre-bundling, can
 * keep their backend files reachable by the plugin.
 */
export function findInstalledBackendFunctionPackages(
    buildRoot: string,
): InstalledBackendFunctionPackage[] {
    const appDir = findNearestManifestDir(buildRoot);
    const appManifest = appDir ? readManifest(path.join(appDir, 'package.json')) : undefined;
    if (!appDir || !appManifest) {
        return [];
    }

    const found = new Map<string, InstalledBackendFunctionPackage>();
    const visited = new Set<string>();
    const pending: Array<{ dir: string; dependencyNames: string[] }> = [
        {
            dir: fs.realpathSync(appDir),
            dependencyNames: getDependencyNames(appManifest, APP_DEPENDENCY_FIELDS),
        },
    ];

    while (pending.length > 0) {
        const { dir, dependencyNames } = pending.shift()!;
        for (const dependencyName of dependencyNames) {
            const packageDir = locateInstalledPackage(dependencyName, dir);
            if (!packageDir) {
                continue;
            }

            const known = found.get(packageDir);
            if (known && !known.importNames.includes(dependencyName)) {
                known.importNames.push(dependencyName);
            }
            if (visited.has(packageDir)) {
                continue;
            }
            visited.add(packageDir);

            const manifest = readManifest(path.join(packageDir, 'package.json'));
            if (!manifest) {
                continue;
            }
            if (providesBackendFunctions(manifest) && typeof manifest.name === 'string') {
                const importNames = [manifest.name];
                if (dependencyName !== manifest.name) {
                    importNames.push(dependencyName);
                }
                found.set(packageDir, { name: manifest.name, root: packageDir, importNames });
            }
            pending.push({
                dir: packageDir,
                dependencyNames: getDependencyNames(manifest, DEPENDENCY_FIELDS),
            });
        }
    }

    return [...found.values()];
}
