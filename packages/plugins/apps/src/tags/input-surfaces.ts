// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * A `surface:<id>` tag for each surface declared by an `@datadog/apps-frontend` input the shipped
 * frontend uses, so product surfaces can find apps meant for them.
 *
 * Read from the shipped chunks rather than the module graph: the SDK's public barrel re-exports
 * every input, so only the rendered, tree-shaken output tells which ones the app actually uses.
 */

import type { TagSource, TagSourceContext } from './types';

const SURFACE_TAG_PREFIX = 'surface:';

/**
 * Marker each `@datadog/apps-frontend` input consumer carries as a string literal:
 * `dd-app-input/v1 <identifier> surfaces=<comma-separated surface ids>`.
 *
 * The literal lives on the consumer itself, so it is tree-shaken with an unused consumer and
 * survives minification and chunk splitting with a used one. Any quote style is accepted, since
 * minifiers pick different ones, but the marker must end at its closing quote: text this grammar
 * doesn't describe is reported rather than read as a truncated surface id.
 */
const MARKER_PREFIX = 'dd-app-input/';
const INPUT_MARKER_RE = /dd-app-input\/v1 [A-Za-z0-9._-]+ surfaces=([A-Za-z0-9._,-]*)(?=["'`])/y;
const UNRECOGNIZED_MARKER_RE = /dd-app-input\/[^"'`\n]{0,120}/y;

type InputMarkers = {
    /** Surface ids declared by the recognized markers, in order of appearance. */
    surfaces: string[];
    /** Text of markers this grammar doesn't describe, e.g. from a newer SDK. */
    unrecognized: string[];
};

/** Reads the input markers found in bundled code. */
const readInputMarkers = (code: string): InputMarkers => {
    const markers: InputMarkers = { surfaces: [], unrecognized: [] };
    for (
        let index = code.indexOf(MARKER_PREFIX);
        index !== -1;
        index = code.indexOf(MARKER_PREFIX, index + MARKER_PREFIX.length)
    ) {
        INPUT_MARKER_RE.lastIndex = index;
        const match = INPUT_MARKER_RE.exec(code);
        if (match) {
            markers.surfaces.push(...match[1].split(',').filter(Boolean));
        } else {
            UNRECOGNIZED_MARKER_RE.lastIndex = index;
            markers.unrecognized.push(UNRECOGNIZED_MARKER_RE.exec(code)![0]);
        }
    }
    return markers;
};

export const inputSurfaceTagSource = ({ log }: TagSourceContext): TagSource => {
    const surfaces = new Set<string>();
    // One warning per distinct unrecognized marker per build, however many chunks repeat it.
    const warned = new Set<string>();
    return {
        readChunk({ fileName, code }) {
            const markers = readInputMarkers(code);
            for (const surface of markers.surfaces) {
                surfaces.add(surface);
            }
            for (const marker of markers.unrecognized) {
                if (warned.has(marker)) {
                    continue;
                }
                warned.add(marker);
                log.warn(
                    `Unrecognized @datadog/apps-frontend input marker "${marker}" in ${fileName}; ` +
                        `its surfaces are not tagged. A newer @datadog/vite-plugin may be needed.`,
                );
            }
        },
        tags: () => Array.from(surfaces, (surface) => `${SURFACE_TAG_PREFIX}${surface}`),
    };
};
