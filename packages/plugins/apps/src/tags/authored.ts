// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { normalizeTag } from './normalize';
import type { TagSource, TagSourceContext } from './types';

const MAX_REPORTED = 5;

/**
 * The tags configured in `apps.tags`. Tags are best effort: a value that isn't a list, or an
 * entry that isn't a non-empty string, is skipped with a warning instead of failing the build.
 * Warnings describe entries by position and type only, since a config value can be anything
 * JavaScript allows.
 */
export const authoredTagSource = ({ options, log }: TagSourceContext): TagSource => {
    const configured: unknown = options.tags;
    const tags: string[] = [];
    if (configured !== undefined && !Array.isArray(configured)) {
        log.warn(`apps.tags should be an array of strings, not ${typeof configured}; ignoring it.`);
    } else if (Array.isArray(configured)) {
        const skipped: string[] = [];
        configured.forEach((tag: unknown, index) => {
            const normalized = typeof tag === 'string' ? normalizeTag(tag) : undefined;
            if (normalized) {
                tags.push(normalized);
            } else {
                skipped.push(
                    `#${index} (${typeof tag === 'string' ? 'empty string' : typeof tag})`,
                );
            }
        });
        if (skipped.length > 0) {
            const more =
                skipped.length > MAX_REPORTED ? ` and ${skipped.length - MAX_REPORTED} more` : '';
            log.warn(
                `apps.tags: skipping ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} that ${skipped.length === 1 ? "isn't a non-empty string" : "aren't non-empty strings"}: ${skipped.slice(0, MAX_REPORTED).join(', ')}${more}.`,
            );
        }
    }
    return { tags: () => [...tags] };
};
