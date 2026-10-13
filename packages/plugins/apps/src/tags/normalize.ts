// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/** Trims and lowercases a tag, or returns undefined for an empty one. */
export const normalizeTag = (tag: string): string | undefined => {
    const normalized = tag.trim().toLowerCase();
    return normalized === '' ? undefined : normalized;
};
