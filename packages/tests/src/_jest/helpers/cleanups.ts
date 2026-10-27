// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import { protectProperties } from 'jest-util';

import type { CleanupFn } from './types';

type CleanupRegistry = { cleanups: CleanupFn[]; workingDirs: string[] };

const REGISTRY_KEY = Symbol.for('@dd/tests/cleanupRegistry');

const isCleanupRegistry = (value: unknown): value is CleanupRegistry => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const cleanups: unknown = Reflect.get(value, 'cleanups');
    const workingDirs: unknown = Reflect.get(value, 'workingDirs');
    return Array.isArray(cleanups) && Array.isArray(workingDirs);
};

// Kept on the test file's global object, which jest.resetModules() doesn't replace, so every copy of
// this module in a file shares one registry, and no file runs another's cleanups.
const getExistingRegistry = () => {
    const existing: unknown = Reflect.get(global, REGISTRY_KEY);
    return isCleanupRegistry(existing) ? existing : undefined;
};

const getRegistry = (): CleanupRegistry => {
    const existing = getExistingRegistry();
    if (existing) {
        return existing;
    }
    const registry: CleanupRegistry = { cleanups: [], workingDirs: [] };
    // A build that outlives its test file can still register after Jest's teardown cleanup.
    protectProperties(registry);
    Reflect.set(global, REGISTRY_KEY, registry);
    return registry;
};

export const addCleanup = (cleanup: CleanupFn) => {
    getRegistry().cleanups.push(cleanup);
};

export const addWorkingDir = (workingDir: string) => {
    getRegistry().workingDirs.push(workingDir);
};

// Run the global cleaning of temp working dirs.
// It is used in an `afterAll` hook in ../setupAfterEnv.ts.
export const cleanupEverything = async () => {
    const registry = getExistingRegistry();
    if (!registry) {
        return;
    }
    const { cleanups, workingDirs } = registry;
    const bundlerCleanups = cleanups.splice(0).map((cleanup) => cleanup());
    const workingDirRemovals = workingDirs.splice(0).map((workingDir) => rm(workingDir));
    const results = await Promise.allSettled([...bundlerCleanups, ...workingDirRemovals]);

    const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length) {
        const failureMessages = failures.map(String).join('\n');
        throw new AggregateError(failures, `Cleanup failed:\n${failureMessages}`);
    }
};
