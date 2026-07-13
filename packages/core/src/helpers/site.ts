// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { SITES } from '@dd/core/constants';

// A site value can be a bare known site (e.g. "datadoghq.com") or a single-label
// custom subdomain on top of one (e.g. "myorg.us5.datadoghq.com"), used by orgs
// with a custom Datadog URL. Picks the longest (most specific) matching base site
// so "myorg.us5.datadoghq.com" resolves to "us5.datadoghq.com", not "datadoghq.com".
// Matching is case-insensitive; the returned site and subdomain are normalized to lowercase.
export const parseSite = (
    value: string,
): { site: (typeof SITES)[number]; subdomain?: string } | undefined => {
    // Config isn't enforced by the type system at runtime (e.g. plain JS configs),
    // so a non-string can reach here despite the `string` signature.
    if (typeof value !== 'string') {
        return undefined;
    }

    const lowerValue = value.toLowerCase();

    const exactMatch = SITES.find((s) => s === lowerValue);
    if (exactMatch) {
        return { site: exactMatch };
    }

    const suffixMatches = SITES.filter((s) => lowerValue.endsWith(`.${s}`));
    if (!suffixMatches.length) {
        return undefined;
    }

    const site = suffixMatches.reduce((longest, s) => (s.length > longest.length ? s : longest));
    const subdomain = lowerValue.slice(0, lowerValue.length - site.length - 1);
    if (!subdomain || !/^[a-z0-9-]+$/.test(subdomain)) {
        return undefined;
    }

    return { site, subdomain };
};
