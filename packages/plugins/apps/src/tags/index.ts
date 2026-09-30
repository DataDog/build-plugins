// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * App tags written to the package manifest.
 *
 * The manifest's `tags` combines every tag source. The backend adds them to the app and never
 * removes any; removing a tag is done in the App Builder UI.
 *
 * Canonical tag formatting lives server-side; this only does the hygiene needed to produce a
 * stable, duplicate-free list, so the two rule sets can't drift apart.
 */

import { authoredTagSource } from './authored';
import { inputSurfaceTagSource } from './input-surfaces';
import type { TagSource, TagSourceContext } from './types';

export type { ShippedChunk, TagSource, TagSourceContext } from './types';

/** Every tag source, in no particular order. Adding a source means adding it here. */
const TAG_SOURCES: Array<(context: TagSourceContext) => TagSource> = [
    authoredTagSource,
    inputSurfaceTagSource,
];

/** Fresh sources for one build; none of them carries anything over from a previous build. */
export const createTagSources = (context: TagSourceContext): TagSource[] =>
    TAG_SOURCES.map((createSource) => createSource(context));

/** Trims and lowercases a tag, or returns undefined for an empty one. */
export const normalizeTag = (tag: string): string | undefined => {
    const normalized = tag.trim().toLowerCase();
    return normalized === '' ? undefined : normalized;
};

/** The manifest's tag list: every source's tags, normalized, deduplicated and sorted. */
export const resolveTags = (sources: TagSource[]): string[] => {
    const tags = new Set<string>();
    for (const source of sources) {
        for (const candidate of source.tags()) {
            const tag = normalizeTag(candidate);
            if (tag) {
                tags.add(tag);
            }
        }
    }
    return [...tags].sort();
};
