// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import type { CleanupFn } from './helpers/types';

const { outputFileSync } =
    jest.requireActual<typeof import('@dd/core/helpers/fs')>('@dd/core/helpers/fs');

// The cleanup fixtures write these files in a directory setupAfterEnv.test.ts gives them, so the
// test can check afterward what setupAfterEnv cleaned up.
export const WORKING_DIR_NAME = 'workingDir';
export const CLEANUP_MARKER = 'cleanupRan';
export const ORPHAN_CLEANUP_MARKER = 'orphanCleanupRan';
export const ORPHAN_REGISTERED_MARKER = 'orphanCleanupRegistered';

export const getMarkerDir = () => {
    const markerDir: unknown = Reflect.get(global, 'CLEANUP_MARKER_DIR');
    if (typeof markerDir !== 'string') {
        throw new Error('The CLEANUP_MARKER_DIR global is required.');
    }
    return markerDir;
};

export const writeMarker = (markerName: string) => {
    const markerDir = getMarkerDir();
    const markerPath = path.join(markerDir, markerName);
    outputFileSync(markerPath, 'written');
};

export const getMarkerCleanup = (markerName: string): CleanupFn => {
    const writeCleanupMarker = async () => {
        writeMarker(markerName);
    };
    return Object.assign(writeCleanupMarker, { errors: [], workingDir: '' });
};
