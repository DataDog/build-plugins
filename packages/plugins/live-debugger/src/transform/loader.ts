// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { transformCode as TransformCodeFn } from './index';

/**
 * Optional peer dependencies that must be present at runtime for the
 * Live Debugger transform to work. They are declared as optional peer
 * dependencies on the published packages so that users who do not enable
 * Live Debugger don't have to install them.
 *
 * The three `@babel/*` packages and `magic-string` are the only non-trivial
 * dependencies pulled in by the transform pipeline. Keeping this list in
 * sync with `peerDependencies` in the published packages is important for
 * the diagnostic message below.
 */
export const REQUIRED_PEER_DEPS = [
    '@babel/parser',
    '@babel/traverse',
    '@babel/types',
    'magic-string',
] as const;

type RequiredPeerDep = (typeof REQUIRED_PEER_DEPS)[number];

// Node attaches a string `code` to filesystem/module resolution errors.
// `NodeJS.ErrnoException` lives in @types/node but isn't available here
// without pulling in the namespace, so we describe the shape inline.
type NodeModuleError = Error & { code?: string };

let cachedTransformCode: typeof TransformCodeFn | undefined;

/**
 * Lazily load the transform module on first use.
 *
 * The transform module statically imports `@babel/types` (used for AST
 * type guards throughout the helpers) and dynamically loads `@babel/parser`,
 * `@babel/traverse`, and `magic-string`. All of them are optional peer
 * dependencies — nothing is loaded here until the plugin has been enabled
 * AND a file actually reaches the transform handler.
 *
 * If a peer dependency is missing, we re-throw with an actionable install
 * hint instead of the raw Node `MODULE_NOT_FOUND`.
 */
export function getTransformCode(): typeof TransformCodeFn {
    if (cachedTransformCode) {
        return cachedTransformCode;
    }

    try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
        const mod = require('./index') as typeof import('./index');
        cachedTransformCode = mod.transformCode;
        return cachedTransformCode;
    } catch (error) {
        throw rewrapMissingPeerDepError(error);
    }
}

/**
 * Wrapper around `require()` that turns `MODULE_NOT_FOUND` into a clear,
 * actionable error pointing at our optional peer dependencies.
 *
 * The name is restricted to the list of known optional peer deps so we
 * can use a static `require()` per target and stay within the repo's
 * lint rules.
 */
export function requireOptionalPeerDep<T>(name: RequiredPeerDep): T {
    try {
        return loadKnownPeerDep(name) as T;
    } catch (error) {
        throw rewrapMissingPeerDepError(error);
    }
}

function loadKnownPeerDep(name: RequiredPeerDep): unknown {
    // Static `require()` calls per dependency (vs a dynamic `require(name)`)
    // so that bundlers and lint rules can analyze them.
    switch (name) {
        case '@babel/parser':
            // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
            return require('@babel/parser');
        case '@babel/traverse':
            // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
            return require('@babel/traverse');
        case '@babel/types':
            // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
            return require('@babel/types');
        case 'magic-string':
            // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
            return require('magic-string');
        default: {
            const exhaustive: never = name;
            throw new Error(`Unknown peer dependency: ${exhaustive as string}`);
        }
    }
}

function rewrapMissingPeerDepError(error: unknown): Error {
    if (!isMissingPeerDepError(error)) {
        return error instanceof Error ? error : new Error(String(error));
    }
    const missingDep = REQUIRED_PEER_DEPS.find((dep) => error.message.includes(dep));
    const target = missingDep ?? REQUIRED_PEER_DEPS.join(', ');
    return new Error(
        `Datadog Live Debugger could not load "${target}". ` +
            `It is an optional peer dependency that must be installed in your project ` +
            `when \`liveDebugger.enable\` is true. Install the peer dependencies with: ` +
            `\`npm install --save-dev ${REQUIRED_PEER_DEPS.join(' ')}\` ` +
            `(or the yarn/pnpm/bun equivalent). ` +
            `Underlying error: ${error.message}`,
    );
}

function isMissingPeerDepError(error: unknown): error is NodeModuleError {
    if (!(error instanceof Error)) {
        return false;
    }
    const code = (error as NodeModuleError).code;
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') {
        return false;
    }
    return REQUIRED_PEER_DEPS.some((dep) => error.message.includes(dep));
}
