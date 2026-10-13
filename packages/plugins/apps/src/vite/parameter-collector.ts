// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';

import { shouldTraverseCollectedModule } from '../backend/ast-parsing/module-graph';
import {
    extractParameterDeclarations,
    importsParametersModule,
    mergeParameterDeclarations,
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
 * clear the stored one while the app still uses parameters.
 */
export function createParameterCollector(getBuildRoot: () => string) {
    // Keyed by full module id so a module re-parsed in watch mode replaces
    // only its own declarations.
    const declarationsByModule = new Map<string, AppsParameterSchema[][]>();

    return {
        /** Reads one parsed module. `parse` is only called for modules that mention the SDK. */
        readModule(id: string, code: string | null, parse: (code: string) => Program): void {
            declarationsByModule.delete(id);
            if (typeof code !== 'string' || !code.includes(PARAMETERS_MODULE)) {
                return;
            }
            const program = parse(code);
            const moduleId = normalizeViteModuleId(id);
            // `params.ts?raw` is a different module from `params.ts`, so a
            // query module is never read as app source.
            const isAppSource =
                id === moduleId &&
                !isViteVirtualModuleId(moduleId) &&
                shouldTraverseCollectedModule(moduleId, getBuildRoot());
            if (isAppSource) {
                declarationsByModule.set(id, extractParameterDeclarations(program, moduleId));
            } else if (importsParametersModule(program)) {
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
