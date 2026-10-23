// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { SITES } from '@dd/core/constants';

const GENERIC_SUBDOMAINS = new Set(['api', 'app']);

// Reduces "  https://MyOrg.datadoghq.com/path?x=1 " to "myorg.datadoghq.com".
const normalizeSiteInput = (value: string): string => {
    const withoutScheme = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const host = withoutScheme.split(/[/?#]/)[0] ?? '';
    return host.trim().toLowerCase();
};

// Mirrors the Datadog apps CLI's site parser; site-vectors.json pins that behavior.
export const parseSite = (
    value: unknown,
): { site: (typeof SITES)[number]; subdomain?: string } | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const normalizedValue = normalizeSiteInput(value);

    const exactMatch = SITES.find((s) => s === normalizedValue);
    if (exactMatch) {
        return { site: exactMatch };
    }

    const suffixMatches = SITES.filter((s) => normalizedValue.endsWith(`.${s}`));
    if (!suffixMatches.length) {
        return undefined;
    }

    const site = suffixMatches.reduce((longest, s) => (s.length > longest.length ? s : longest));
    const subdomain = normalizedValue.slice(0, normalizedValue.length - site.length - 1);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
        return undefined;
    }
    if (GENERIC_SUBDOMAINS.has(subdomain)) {
        return { site };
    }

    return { site, subdomain };
};
