// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createEpochGuard } from '@dd/apps-plugin/vite/execution-epoch';

describe('execution-epoch — createEpochGuard', () => {
    test('Should report a fresh scope as current and report no active scope before any start()', () => {
        const guard = createEpochGuard();
        expect(guard.hasActiveScope()).toBe(false);

        const scope = guard.start();
        expect(scope.isCurrent()).toBe(true);
        expect(guard.hasActiveScope()).toBe(true);
    });

    test('Should invalidate an older scope once a newer one starts', () => {
        const guard = createEpochGuard();
        const older = guard.start();
        expect(older.isCurrent()).toBe(true);

        const newer = guard.start();
        expect(older.isCurrent()).toBe(false);
        expect(newer.isCurrent()).toBe(true);
        expect(guard.hasActiveScope()).toBe(true);
    });

    test('Should make concludeIfCurrent a no-op returning false for an already-superseded scope', () => {
        const guard = createEpochGuard();
        const older = guard.start();
        guard.start();

        expect(older.concludeIfCurrent()).toBe(false);
        // The newer scope must be unaffected by the older one's no-op conclude.
        expect(guard.hasActiveScope()).toBe(true);
    });

    test('Should conclude a still-current scope, clearing hasActiveScope', () => {
        const guard = createEpochGuard();
        const scope = guard.start();

        expect(scope.concludeIfCurrent()).toBe(true);
        expect(scope.isCurrent()).toBe(false);
        expect(guard.hasActiveScope()).toBe(false);
    });

    test('Should make a second concludeIfCurrent call on the same scope a no-op', () => {
        const guard = createEpochGuard();
        const scope = guard.start();

        expect(scope.concludeIfCurrent()).toBe(true);
        expect(scope.concludeIfCurrent()).toBe(false);
    });

    test('Should invalidate the active scope and clear hasActiveScope on forceInvalidate, without starting a new one', () => {
        const guard = createEpochGuard();
        const scope = guard.start();

        guard.forceInvalidate();

        expect(scope.isCurrent()).toBe(false);
        expect(guard.hasActiveScope()).toBe(false);
    });

    test('Should make forceInvalidate followed by a fresh start() behave like an ordinary new scope', () => {
        const guard = createEpochGuard();
        const abandoned = guard.start();
        guard.forceInvalidate();

        const current = guard.start();

        expect(abandoned.isCurrent()).toBe(false);
        expect(current.isCurrent()).toBe(true);
        expect(guard.hasActiveScope()).toBe(true);

        // The abandoned scope's late conclude must not corrupt the new one.
        expect(abandoned.concludeIfCurrent()).toBe(false);
        expect(current.isCurrent()).toBe(true);
    });

    test('Should keep independently-created guards from sharing any state', () => {
        const guardA = createEpochGuard();
        const guardB = createEpochGuard();

        const scopeA = guardA.start();
        expect(guardB.hasActiveScope()).toBe(false);
        expect(scopeA.isCurrent()).toBe(true);
    });
});
