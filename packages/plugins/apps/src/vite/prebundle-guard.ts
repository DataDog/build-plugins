// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { UserConfig } from 'vite';

import { getBackendModuleOwner } from '../backend/backend-sources';
import { BACKEND_FILE_RE } from '../constants';

const GUARD_NAME = 'dd-apps-backend-prebundle-guard';

// Vite's own view of esbuild's plugin type, which can differ from this package's esbuild version.
type EsbuildOptions = NonNullable<NonNullable<UserConfig['optimizeDeps']>['esbuildOptions']>;
type EsbuildPlugin = NonNullable<EsbuildOptions['plugins']>[number];

/**
 * Why pre-bundling must not include `filePath`, if it's a backend function file of a package that
 * provides backend functions. The dev server excludes every such package it finds in the app's
 * dependency tree from `optimizeDeps`; one it missed (an undeclared dependency, an alias, a
 * user's `optimizeDeps.include`) would have its backend body inlined into a browser chunk where
 * this plugin's transform never sees it.
 */
export function getPreBundledBackendFileError(
    filePath: string,
    buildRoot: string,
): string | undefined {
    if (!BACKEND_FILE_RE.test(filePath)) {
        return undefined;
    }
    const owner = getBackendModuleOwner(filePath, buildRoot);
    if (owner.kind !== 'backend-package') {
        return undefined;
    }
    const { name } = owner.package;
    return (
        `Dependency pre-bundling reached ${filePath}, a backend function of "${name}", which ` +
        `provides backend functions: its real body would ship to the browser instead of the ` +
        `proxy. Add "${name}" to optimizeDeps.exclude in your Vite config.`
    );
}

/** Fails Vite's esbuild-based dependency optimizer (Vite 7 and earlier) on a backend function file. */
export function createEsbuildPreBundleGuard(buildRoot: string): EsbuildPlugin {
    return {
        name: GUARD_NAME,
        setup(build) {
            build.onLoad({ filter: BACKEND_FILE_RE }, (args) => {
                const error = getPreBundledBackendFileError(args.path, buildRoot);
                return error ? { errors: [{ text: error }] } : undefined;
            });
        },
    };
}

/** The same guard for Vite 8's Rolldown-based dependency optimizer. */
export function createRolldownPreBundleGuard(buildRoot: string) {
    return {
        name: GUARD_NAME,
        load: {
            filter: { id: { include: [BACKEND_FILE_RE] } },
            handler(id: string) {
                const [filePath] = id.split(/[?#]/);
                const error = getPreBundledBackendFileError(filePath, buildRoot);
                if (error) {
                    throw new Error(error);
                }
                return null;
            },
        },
    };
}
