// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const INJECTED_FILE = '__datadog-helper-file';
export const INJECTED_FILE_RX = new RegExp(INJECTED_FILE);

export const ALL_ENVS = ['development', 'production', 'test'] as const;
export const ALL_BUNDLERS = ['webpack', 'vite', 'esbuild', 'rollup', 'rspack', 'rolldown', 'farm'];
export const SUPPORTED_BUNDLERS = ['webpack', 'vite', 'esbuild', 'rollup', 'rspack'] as const;

// source of truth: site parameter column of the site list in
// https://docs.datadoghq.com/getting_started/site/
export const SITES = [
    'datadoghq.com',
    'us3.datadoghq.com',
    'us5.datadoghq.com',
    'datadoghq.eu',
    'ddog-gov.com',
    'us2.ddog-gov.com',
    'ap1.datadoghq.com',
    'ap2.datadoghq.com',
    'datad0g.com',
] as const;

export const DEFAULT_SITE = SITES[0];

// A site value can be a bare known site (e.g. "datadoghq.com") or a single-label
// custom subdomain on top of one (e.g. "myorg.us5.datadoghq.com"), used by orgs
// with a custom Datadog URL. Picks the longest (most specific) matching base site
// so "myorg.us5.datadoghq.com" resolves to "us5.datadoghq.com", not "datadoghq.com".
export const parseSite = (
    value: string,
): { site: (typeof SITES)[number]; subdomain?: string } | undefined => {
    const exactMatch = SITES.find((s) => s === value);
    if (exactMatch) {
        return { site: exactMatch };
    }

    const suffixMatches = SITES.filter((s) => value.endsWith(`.${s}`));
    if (!suffixMatches.length) {
        return undefined;
    }

    const site = suffixMatches.reduce((longest, s) => (s.length > longest.length ? s : longest));
    const subdomain = value.slice(0, value.length - site.length - 1);
    if (!subdomain || !/^[a-z0-9-]+$/i.test(subdomain)) {
        return undefined;
    }

    return { site, subdomain };
};

export const ENV_VAR_REQUESTED_BUNDLERS = 'PLAYWRIGHT_REQUESTED_BUNDLERS';

export const HOST_NAME = 'datadog-build-plugins';
