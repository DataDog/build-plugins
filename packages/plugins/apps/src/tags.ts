// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * App tags written to the package manifest.
 *
 * The manifest's `tags` is the app's complete tag list: authored tags (`apps.tags`) plus one
 * `surface:<id>` tag for each surface declared by an input the app's shipped frontend actually
 * uses. The backend makes the app's tags equal to this list, so a derived tag disappears on the
 * next deploy once its input stops being used.
 *
 * Canonical tag formatting lives server-side; this only does the hygiene needed to produce a
 * stable, duplicate-free list, so the two rule sets can't drift apart.
 */

export const SURFACE_TAG_PREFIX = 'surface:';

/**
 * Marker each `@datadog/apps-frontend` input consumer carries as a string literal:
 * `dd-app-input/v1 <identifier> surfaces=<comma-separated surface ids>`.
 *
 * The literal lives on the consumer itself, so it is tree-shaken with an unused consumer and
 * survives minification and chunk splitting with a used one. Matching deliberately ignores the
 * surrounding quotes, since different minifiers pick different quote styles.
 */
const INPUT_MARKER_RE = /dd-app-input\/v1 ([A-Za-z0-9._-]+) surfaces=([A-Za-z0-9._,-]*)/g;

/** Surface ids declared by every input marker found in bundled code. */
export const findInputSurfaces = (code: string): string[] => {
    const surfaces: string[] = [];
    for (const [, , surfaceList] of code.matchAll(INPUT_MARKER_RE)) {
        surfaces.push(...surfaceList.split(',').filter(Boolean));
    }
    return surfaces;
};

/** Trims and lowercases a tag, or returns undefined for an empty one. */
export const normalizeTag = (tag: string): string | undefined => {
    const normalized = tag.trim().toLowerCase();
    return normalized === '' ? undefined : normalized;
};

/**
 * The app's complete, sorted, duplicate-free tag list: authored tags union a `surface:<id>` tag
 * per used input surface.
 */
export const resolveAppTags = (authoredTags: string[], surfaceIds: Iterable<string>): string[] => {
    const tags = new Set<string>();
    const candidates = [
        ...authoredTags,
        ...Array.from(surfaceIds, (surfaceId) => `${SURFACE_TAG_PREFIX}${surfaceId}`),
    ];
    for (const candidate of candidates) {
        const tag = normalizeTag(candidate);
        if (tag) {
            tags.add(tag);
        }
    }
    return [...tags].sort();
};
