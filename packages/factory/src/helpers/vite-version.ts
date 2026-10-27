// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// The oldest line Vite still patches: https://vite.dev/releases#supported-versions
export const MIN_VITE_VERSION = '6.4.0';
export const MAX_VITE_MAJOR = 8;

const [MIN_MAJOR, MIN_MINOR] = MIN_VITE_VERSION.split('.').map(Number);

// An unreadable version is left alone: the warning is advice, not a gate.
export const getUnsupportedViteWarning = (version: unknown): string | undefined => {
    if (typeof version !== 'string') {
        return undefined;
    }

    const match = /^(\d+)\.(\d+)\./.exec(version);
    if (!match) {
        return undefined;
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
        return `Vite ${version} is deprecated in Datadog's Vite plugin: please upgrade to Vite ${MIN_MAJOR}.${MIN_MINOR} or later.`;
    }

    if (major > MAX_VITE_MAJOR) {
        return `Datadog's Vite plugin is tested up to Vite ${MAX_VITE_MAJOR}.x (found ${version}).`;
    }

    return undefined;
};
