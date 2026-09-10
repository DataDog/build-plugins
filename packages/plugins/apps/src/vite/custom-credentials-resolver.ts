// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global NodeJS */

import { readFile } from '@dd/core/helpers/fs';
import path from 'node:path';

/** One process.env entry per secret the developer has supplied locally, keyed the same way production's resolved Custom Credentials env vars are (e.g. `STRIPE_API_KEY`). */
export type ResolvedCustomCredentials = Record<string, string>;

/**
 * A git-ignored file the developer maintains themselves with real Custom Credentials values for
 * local execution — no server call, no new auth model, since no server-side resolution endpoint
 * exists for this. Same convention Rapid already documents for local secrets (`config/dev.json`,
 * gitignored), applied here to Custom Credentials.
 */
export const CUSTOM_CREDENTIALS_LOCAL_FILENAME = 'datadog-app.local.json';

/**
 * Resolves Custom Credentials for local execution by reading {@link CUSTOM_CREDENTIALS_LOCAL_FILENAME}
 * from the project root. A missing file resolves to `{}` — most projects won't have one — but a
 * present-and-malformed file throws, since silently ignoring a typo would make a declared secret
 * look identical to an undeclared one.
 */
export async function resolveCustomCredentials(
    projectRoot: string,
): Promise<ResolvedCustomCredentials> {
    const filePath = path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME);
    let raw: string;
    try {
        raw = await readFile(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Never interpolate the underlying JSON.parse error here: V8's own message can embed a
        // raw slice of the source text (e.g. `..."API_KEY": sk_test_ab"...`) when the malformed
        // token looks like an unquoted value, which would echo a real secret into this error's
        // message — and from there into the dev server's debug log and its HTTP response body.
        throw new Error(`${CUSTOM_CREDENTIALS_LOCAL_FILENAME} is not valid JSON.`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(
            `${CUSTOM_CREDENTIALS_LOCAL_FILENAME} must be a flat JSON object mapping env var names to string values.`,
        );
    }

    // Object.create(null) rather than {} so a credential literally named "__proto__" round-trips
    // as a normal own property instead of silently no-op'ing against Object.prototype's setter.
    const resolved: ResolvedCustomCredentials = Object.create(null);
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') {
            throw new Error(
                `${CUSTOM_CREDENTIALS_LOCAL_FILENAME}'s "${key}" value must be a string, got ${typeof value}.`,
            );
        }
        resolved[key] = value;
    }
    return resolved;
}
