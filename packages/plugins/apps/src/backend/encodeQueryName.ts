// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createHash } from 'crypto';

import type { BackendFunction } from './discovery';

/**
 * Encode a BackendFunction into an opaque query name string.
 * Uses the full SHA-256 hash of the path so that backend file structure
 * is never leaked into frontend assets.
 *
 * This is the single source of truth for query name encoding — used by
 * proxy codegen, the production build, and the dev server.
 */
export function encodeQueryName(ref: Pick<BackendFunction, 'path' | 'name'>): string {
    const pathHash = createHash('sha256').update(ref.path).digest('hex');
    return `${pathHash}.${ref.name}`;
}
