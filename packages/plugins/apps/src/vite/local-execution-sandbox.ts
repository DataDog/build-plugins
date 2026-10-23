// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/** What a local execution child process may read and write: Node permission flags and the checks on modules it loads over IPC. */

import { existsSync } from '@dd/core/helpers/fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';

import { isOutsideRoot } from '../backend/ast-parsing/module-graph';

import { isIndexableRecord } from './local-execution-shared';

function permissionFlag(nodeFlags: ReadonlySet<string>): string | undefined {
    return ['--permission', '--experimental-permission'].find((flag) => nodeFlags.has(flag));
}

/** Node's permission model flags for a call, or undefined when this Node has none, or has no `--allow-inspector` while debugging; the child then installs the in-process guards instead. */
export function permissionModelArgv(options: {
    readPaths: string[];
    writePaths: string[];
    nodeFlags: ReadonlySet<string>;
    inspect: boolean;
}): string[] | undefined {
    const { readPaths, writePaths, nodeFlags, inspect } = options;
    const permission = permissionFlag(nodeFlags);
    if (!permission || (inspect && !nodeFlags.has('--allow-inspector'))) {
        return undefined;
    }
    const argv: string[] = [];
    if (nodeFlags.has('--disable-warning')) {
        // Node 20's permission model and Node 25+'s --allow-net print an ExperimentalWarning per call.
        argv.push('--disable-warning=ExperimentalWarning');
    }
    argv.push(permission);
    for (const readPath of [...readPaths, ...writePaths]) {
        argv.push(`--allow-fs-read=${readPath}`);
    }
    for (const writePath of writePaths) {
        argv.push(`--allow-fs-write=${writePath}`);
    }
    if (nodeFlags.has('--allow-net')) {
        argv.push('--allow-net');
    }
    if (inspect) {
        argv.push('--allow-inspector');
    }
    return argv;
}

export function withRealPath(filePath: string): string[] {
    try {
        const realPath = fs.realpathSync.native(filePath);
        return realPath === filePath ? [filePath] : [filePath, realPath];
    } catch {
        return [filePath];
    }
}

function isWithin(root: string, filePath: string): boolean {
    const relativePath = path.relative(root, filePath);
    return !isOutsideRoot(relativePath);
}

function readDirEntries(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

/** Where `npm link` or a `file:` dependency points, outside `node_modules`. */
function linkedPackages(nodeModules: string): string[] {
    const links: string[] = [];
    for (const entry of readDirEntries(nodeModules)) {
        const entryPath = path.join(nodeModules, entry.name);
        if (entry.isSymbolicLink()) {
            links.push(entryPath);
        } else if (entry.name.startsWith('@') && entry.isDirectory()) {
            const scopedEntries = readDirEntries(entryPath);
            const scopedLinks = scopedEntries.filter((child) => child.isSymbolicLink());
            const scopedLinkPaths = scopedLinks.map((child) => path.join(entryPath, child.name));
            links.push(...scopedLinkPaths);
        }
    }
    // A pnpm link into node_modules/.pnpm is already readable.
    const targets = links.flatMap((link) => withRealPath(link).slice(1));
    return targets.filter((target) => !isWithin(nodeModules, target));
}

// Each path is a separate flag on the child's command line, which Windows caps at 32,767 characters.
function withoutNestedPaths(paths: string[]): string[] {
    const byLength = [...new Set(paths)].sort((a, b) => a.length - b.length);
    const kept: string[] = [];
    for (const candidate of byLength) {
        if (!kept.some((root) => isWithin(root, candidate))) {
            kept.push(candidate);
        }
    }
    return kept;
}

/** The project, the child entry, Vite's module runner, `extraRoots`, and every `node_modules` up from the project and from each package linked into one, which a hoisted dependency can live in. */
export function collectReadPaths(
    projectRoot: string,
    childEntryPath: string,
    moduleRunnerPath: string,
    extraRoots: string[] = [],
): string[] {
    const childEntryDir = path.dirname(childEntryPath);
    const moduleRunnerDir = path.dirname(moduleRunnerPath);
    const paths = [projectRoot, childEntryDir, moduleRunnerDir, ...extraRoots];
    const walkedNodeModules = new Set<string>();
    const startDirs = new Set([projectRoot]);
    for (const startDir of startDirs) {
        for (let dir = startDir; ; dir = path.dirname(dir)) {
            const nodeModules = path.join(dir, 'node_modules');
            if (!walkedNodeModules.has(nodeModules) && existsSync(nodeModules)) {
                walkedNodeModules.add(nodeModules);
                const links = linkedPackages(nodeModules);
                paths.push(nodeModules, ...links);
                links.forEach((link) => startDirs.add(link));
            }
            if (path.dirname(dir) === dir) {
                break;
            }
        }
    }
    const pathsWithRealPaths = paths.flatMap(withRealPath);
    return withoutNestedPaths(pathsWithRealPaths);
}

// Production's os.tmpdir() is /tmp, and some dependencies write there directly.
export function sharedTmpPaths(): string[] {
    return process.platform !== 'win32' && existsSync('/tmp') ? withRealPath('/tmp') : [];
}

type FileFilter = (filePath: string) => boolean;

// Vite's own server.fs.deny matching: a pattern without a slash matches at any depth.
export function createDenyFilter(denyPatterns: string[]): FileFilter {
    const globs = denyPatterns.map((pattern) =>
        pattern.includes('/') ? pattern : `**/${pattern}`,
    );
    const matchesDeny = picomatch(globs, { matchBase: false, nocase: true, dot: true });
    return (filePath) => {
        const posixPath = filePath.split(path.sep).join('/');
        return matchesDeny(posixPath);
    };
}

/** Undoes Vite's `/@id/` wrapping of a module id it couldn't keep as a URL, `\0` included. */
function unwrapModuleId(url: string): string {
    return url.startsWith('/@id/') ? url.slice('/@id/'.length).replace('__x00__', '\0') : url;
}

/** The file behind a resolved module id; undefined for a virtual id. */
export function fileOfModuleId(id: string): string | undefined {
    const unwrappedId = unwrapModuleId(id);
    const cleanId = unwrappedId.replace(/[?#].*$/, '');
    if (cleanId.startsWith('\0')) {
        return undefined;
    }
    if (cleanId.startsWith('file://')) {
        return fileURLToPath(cleanId);
    }
    const fsPath = cleanId.startsWith('/@fs/') ? cleanId.slice('/@fs'.length) : cleanId;
    // Vite writes a Windows path as /@fs/C:/...
    const filePath = /^\/[A-Za-z]:\//.test(fsPath) ? fsPath.slice(1) : fsPath;
    return path.isAbsolute(filePath) || path.win32.isAbsolute(filePath) ? filePath : undefined;
}

export const OUTSIDE_READ_ROOTS_REASON = "it's outside the folders a backend function can read";
export const DENIED_MODULE_REASON =
    "it matches Vite's `server.fs.deny`, which a backend function can't load";

/** Why a call can't load a file, or undefined when it can. */
export type ModuleRefusal = (file: string) => string | undefined;

export function unreadableModuleError(target: string, reason: string) {
    return {
        error: {
            name: 'Error',
            message: `Local execution can't load "${target}": ${reason}.`,
        },
    };
}

/**
 * A module that fails to load comes back with Vite's error, which can quote its source (a code frame,
 * or a line of it in the message). Only an error about a file a call can read keeps those details.
 */
export function guardModuleLoadError(response: unknown, refusalOf: ModuleRefusal): unknown {
    const error = isIndexableRecord(response) ? response.error : undefined;
    if (!isIndexableRecord(error)) {
        return response;
    }
    const loc = isIndexableRecord(error.loc) ? error.loc : undefined;
    const candidates = [error.id, loc?.file, error.file];
    const errorId = candidates.find((candidate) => typeof candidate === 'string');
    const file = typeof errorId === 'string' ? fileOfModuleId(errorId) : undefined;
    if (file !== undefined) {
        const reason = refusalOf(file);
        return reason === undefined ? response : unreadableModuleError(file, reason);
    }
    const name = typeof error.name === 'string' ? error.name : 'Error';
    const message = typeof error.message === 'string' ? error.message : 'The module failed to load';
    const [firstLine] = message.split('\n');
    // Kept so a caller can still tell a missing optional import by its code.
    const code = typeof error.code === 'string' ? { code: error.code } : {};
    return { error: { name, message: firstLine, ...code } };
}

export interface ModuleLoadGuardOptions {
    /** The folders module loads are limited to; undefined when Vite's `server.fs.strict` is off. */
    readPaths: string[] | undefined;
    denyPatterns: string[];
    resolveModule: (url: string, importer: string | undefined) => Promise<string | undefined>;
}

export interface ModuleLoadGuard {
    /** Refuses a `fetchModule` request before Vite reads the file. */
    refusalBeforeLoad(url: string, importer: unknown): Promise<unknown>;
    checkResponse(response: unknown): unknown;
}

export function createModuleLoadGuard(options: ModuleLoadGuardOptions): ModuleLoadGuard {
    const { readPaths, resolveModule } = options;
    const isDenied = createDenyFilter(options.denyPatterns);
    const realPaths = new Map<string, string>();
    const resolvedFiles = new Map<string, string | undefined>();

    // The real path decides, since that's the file Vite reads. A path with nothing on disk passes:
    // there's nothing to read there, and a plugin's virtual module can look like one.
    const refusalOf: ModuleRefusal = (filePath) => {
        let realPath = realPaths.get(filePath);
        if (realPath === undefined) {
            try {
                realPath = fs.realpathSync.native(filePath);
            } catch {
                return undefined;
            }
            realPaths.set(filePath, realPath);
        }
        const checkedPath = realPath;
        // Vite denies by the requested name, so a denied name linking elsewhere stays denied.
        if (isDenied(filePath) || isDenied(checkedPath)) {
            return DENIED_MODULE_REASON;
        }
        const isReadable = !readPaths || readPaths.some((root) => isWithin(root, checkedPath));
        return isReadable ? undefined : OUTSIDE_READ_ROOTS_REASON;
    };

    const fileRequestedBy = async (url: string, importer: unknown) => {
        const moduleId = unwrapModuleId(url);
        // Like Vite's fetchModule, only a bare specifier resolves from its importer.
        const isBareSpecifier = !moduleId.startsWith('.') && !moduleId.startsWith('/');
        const importerId = isBareSpecifier && typeof importer === 'string' ? importer : undefined;
        const cacheKey = `${importerId ?? ''}\0${moduleId}`;
        if (resolvedFiles.has(cacheKey)) {
            return resolvedFiles.get(cacheKey);
        }
        const resolvedId = await resolveModule(moduleId, importerId).catch(() => undefined);
        // An id Vite can't resolve yet fails to load on its own, and may resolve once created.
        if (resolvedId === undefined) {
            return undefined;
        }
        const file = fileOfModuleId(resolvedId);
        resolvedFiles.set(cacheKey, file);
        return file;
    };

    return {
        refusalBeforeLoad: async (url, importer) => {
            // Vite's resolver follows links, so the name asked for is checked on its own.
            const namedFile = fileOfModuleId(url);
            if (namedFile && isDenied(namedFile)) {
                return unreadableModuleError(namedFile, DENIED_MODULE_REASON);
            }
            const requestedFile = await fileRequestedBy(url, importer);
            const reason = requestedFile && refusalOf(requestedFile);
            return requestedFile && reason
                ? unreadableModuleError(requestedFile, reason)
                : undefined;
        },
        checkResponse: (response) => {
            const fetched = isIndexableRecord(response) ? response.result : undefined;
            const fetchedId = isIndexableRecord(fetched) ? fetched.file : undefined;
            const fetchedFile =
                typeof fetchedId === 'string' ? fileOfModuleId(fetchedId) : undefined;
            const reason = fetchedFile === undefined ? undefined : refusalOf(fetchedFile);
            if (fetchedFile !== undefined && reason !== undefined) {
                return unreadableModuleError(fetchedFile, reason);
            }
            return guardModuleLoadError(response, refusalOf);
        },
    };
}
