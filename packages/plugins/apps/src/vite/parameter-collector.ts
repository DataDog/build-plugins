// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';
import fs from 'fs';
import path from 'path';

import { isAppSourceModule } from '../backend/backend-sources';
import {
    extractParameterDeclarations,
    importsParametersModule,
    mergeParameterDeclarations,
    moduleSpecifiers,
    PARAMETERS_MODULE,
} from '../parameters/extract-parameters';
import type { AppsParameterSchema } from '../types';

import { isViteVirtualModuleId, normalizeViteModuleId } from './backend-module-graph-collector';

/**
 * Collects the app's parameter declarations from the modules of one
 * production build, and of later watch-mode rebuilds. The build root is read
 * per module because it is only known once the bundler's config is resolved.
 *
 * Only the app's own JavaScript and TypeScript source is read. Any other
 * module that imports `@datadog/apps-frontend/parameters` fails the build,
 * because leaving its declaration out would upload an empty declaration and
 * clear the stored one while the app still uses parameters. So does app
 * source that reaches the module through an alias or path mapping, since
 * declarations are found by the import's literal specifier.
 *
 * `getParametersModuleId` returns the id the bundler resolved
 * `@datadog/apps-frontend/parameters` to, when it resolves at all.
 */
export function createParameterCollector(
    getBuildRoot: () => string,
    getParametersModuleId: () => string | undefined = () => undefined,
) {
    // Keyed by full module id so a module re-parsed in watch mode replaces
    // only its own declarations.
    const declarationsByModule = new Map<string, AppsParameterSchema[][]>();
    // Module ids are real paths, so the root must be one too, or an app under
    // a symlinked root would look like it lives outside itself.
    let realBuildRoot: { root: string; real: string } | undefined;
    const getRealBuildRoot = () => {
        const root = getBuildRoot();
        if (realBuildRoot?.root !== root) {
            realBuildRoot = { root, real: realPath(root) };
        }
        return realBuildRoot.real;
    };

    return {
        /**
         * Reads one parsed module. `importedIds` are the resolved ids it imports,
         * statically or dynamically, and `resolve` resolves one of its
         * specifiers. `parse` is only called for modules that mention or import
         * the SDK.
         */
        async readModule(
            id: string,
            code: string | null,
            importedIds: readonly string[],
            parse: (code: string) => Program,
            resolve: (specifier: string) => Promise<string | undefined>,
        ): Promise<void> {
            declarationsByModule.delete(id);
            if (typeof code !== 'string') {
                return;
            }
            const parametersModuleId = getParametersModuleId();
            const importsResolvedModule =
                parametersModuleId !== undefined && importedIds.includes(parametersModuleId);
            if (!code.includes(PARAMETERS_MODULE) && !importsResolvedModule) {
                return;
            }
            const program = parse(code);
            const moduleId = normalizeViteModuleId(id);
            // `params.ts?raw` is a different module from `params.ts`, so a
            // query module is never read as app source.
            const isAppSource =
                id === moduleId &&
                !isViteVirtualModuleId(moduleId) &&
                isAppSourceModule(realPath(moduleId), getRealBuildRoot());
            const aliasedSpecifier = importsResolvedModule
                ? await findAliasedSpecifier(program, resolve, parametersModuleId)
                : undefined;
            // The bundler sees an import of the SDK that no literal specifier
            // accounts for, such as one built from a template string.
            const hasUnreadableImport =
                importsResolvedModule &&
                aliasedSpecifier === undefined &&
                !importsParametersModule(program);
            if (isAppSource) {
                if (aliasedSpecifier !== undefined) {
                    throw new Error(
                        `${id} imports ${PARAMETERS_MODULE} as '${aliasedSpecifier}', through an alias or path mapping, so the build can't read its parameter declarations. Import it as '${PARAMETERS_MODULE}', or set apps.parameters.`,
                    );
                }
                if (hasUnreadableImport) {
                    throw new Error(
                        `${id} imports ${PARAMETERS_MODULE} in a way the build can't read. Import it with a static '${PARAMETERS_MODULE}' specifier, or set apps.parameters.`,
                    );
                }
                declarationsByModule.set(id, extractParameterDeclarations(program, moduleId));
            } else if (
                importsParametersModule(program) ||
                // The SDK's own files import it by relative path.
                ((aliasedSpecifier !== undefined || hasUnreadableImport) &&
                    !isInsidePackageOf(realPath(moduleId), parametersModuleId))
            ) {
                throw new Error(
                    `${id} imports ${PARAMETERS_MODULE}, but the build only reads parameter declarations from the app's own JavaScript and TypeScript source, outside node_modules. Move the declaration into the app's source, or set apps.parameters.`,
                );
            }
        },
        /** Forgets modules that are no longer part of the build, such as a deleted import. */
        retainModules(ids: Iterable<string>): void {
            const current = new Set(ids);
            for (const id of declarationsByModule.keys()) {
                if (!current.has(id)) {
                    declarationsByModule.delete(id);
                }
            }
        },
        /** The app's complete declaration; empty when the build found none. */
        resolve(): AppsParameterSchema[] {
            return mergeParameterDeclarations(declarationsByModule);
        },
    };
}

/** The path with symlinks resolved, or the path itself when it doesn't exist on disk. */
function realPath(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return filePath;
    }
}

/**
 * The first specifier, other than the literal one, that resolves to the SDK.
 * Checked per specifier, since bundlers merge imports of the same module, so a
 * literal import can sit alongside an aliased one.
 */
async function findAliasedSpecifier(
    program: Program,
    resolve: (specifier: string) => Promise<string | undefined>,
    parametersModuleId: string | undefined,
): Promise<string | undefined> {
    for (const specifier of moduleSpecifiers(program)) {
        // eslint-disable-next-line no-await-in-loop
        if (specifier !== PARAMETERS_MODULE && (await resolve(specifier)) === parametersModuleId) {
            return specifier;
        }
    }
    return undefined;
}

/** Whether `filePath` is inside the npm package that contains `moduleId`. */
function isInsidePackageOf(filePath: string, moduleId: string | undefined): boolean {
    if (moduleId === undefined) {
        return false;
    }
    let directory = path.dirname(realPath(moduleId));
    while (!fs.existsSync(path.join(directory, 'package.json'))) {
        const parent = path.dirname(directory);
        if (parent === directory) {
            return false;
        }
        directory = parent;
    }
    return !path.relative(directory, filePath).startsWith('..');
}
