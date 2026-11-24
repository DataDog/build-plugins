// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import semver from 'semver';

// The oldest line Vite still patches: https://vite.dev/releases#supported-versions
export const MIN_VITE_VERSION = '6.4.0';
export const MAX_VITE_MAJOR = 8;

const MIN_VITE_LINE = `${semver.major(MIN_VITE_VERSION)}.${semver.minor(MIN_VITE_VERSION)}`;

// An unreadable version is left alone: the warning is advice, not a gate.
export const getUnsupportedViteWarning = (version: unknown): string | undefined => {
    const parsed = typeof version === 'string' ? semver.parse(version) : null;
    if (!parsed) {
        return undefined;
    }

    const supported = `Datadog's Vite plugin supports Vite ${MIN_VITE_VERSION} to ${MAX_VITE_MAJOR}.x (found ${version})`;
    if (semver.lt(parsed, MIN_VITE_VERSION)) {
        return `${supported}: please upgrade to Vite ${MIN_VITE_LINE} or later.`;
    }

    if (parsed.major > MAX_VITE_MAJOR) {
        return `${supported}.`;
    }

    return undefined;
};
