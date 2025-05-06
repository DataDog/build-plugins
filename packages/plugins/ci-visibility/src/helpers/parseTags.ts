import type { LogTags } from '@dd/core/types';

import { BUILD_PLUGIN_SPAN_PREFIX } from '../constants';
import type { SpanTag, SpanTags } from '../types';

export const parseTags = (spanTags: SpanTags, tags: LogTags): SpanTags => {
    const parsedTags: SpanTags = {};
    const allTagsWithUniqueValues: Record<string, Set<string>> = {};

    // Add the default tags to the temporary tags Sets.
    for (const [key, value] of Object.entries(spanTags)) {
        if (value) {
            allTagsWithUniqueValues[key] = new Set(value.split(/ *, */g));
        }
    }

    // Get all the tags and their (unique) values.
    for (const tag of tags) {
        const [key, ...rest] = tag.split(/ *: */g);
        const verifiedKey =
            key.startsWith(BUILD_PLUGIN_SPAN_PREFIX) || allTagsWithUniqueValues[key]
                ? key
                : `${BUILD_PLUGIN_SPAN_PREFIX}.${key}`;
        const value = rest.join(':');

        // If the value is already in the set, skip it.
        if (allTagsWithUniqueValues[verifiedKey]?.has(value)) {
            continue;
        }

        // If the key doesn't exist, create a new set.
        if (!allTagsWithUniqueValues[verifiedKey]) {
            allTagsWithUniqueValues[verifiedKey] = new Set();
        }

        allTagsWithUniqueValues[verifiedKey].add(value);
    }

    // Convert the sets into SpanTags.
    for (const [key, value] of Object.entries(allTagsWithUniqueValues)) {
        const stringValue = Array.from(value).join(',');
        if (!stringValue) {
            continue;
        }

        parsedTags[key as SpanTag] = stringValue;
    }

    return parsedTags;
};
