// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createEpochGuard } from '@dd/apps-plugin/vite/execution-epoch';

describe('execution-epoch — createEpochGuard', () => {
    test('Should invalidate an older scope once a newer one starts', () => {
        const guard = createEpochGuard();
        const older = guard.start();
        expect(older.isCurrent()).toBe(true);

        const newer = guard.start();
        expect(older.isCurrent()).toBe(false);
        expect(newer.isCurrent()).toBe(true);
    });

    test('Should make concludeIfCurrent a no-op returning false for an already-superseded scope', () => {
        const guard = createEpochGuard();
        const older = guard.start();
        const newer = guard.start();

        expect(older.concludeIfCurrent()).toBe(false);
        // The newer scope must be unaffected by the older one's no-op conclude.
        expect(newer.isCurrent()).toBe(true);
    });

    test('Should conclude a still-current scope, marking it no longer current', () => {
        const guard = createEpochGuard();
        const scope = guard.start();

        expect(scope.concludeIfCurrent()).toBe(true);
        expect(scope.isCurrent()).toBe(false);
    });

    test('Should make a second concludeIfCurrent call on the same scope a no-op', () => {
        const guard = createEpochGuard();
        const scope = guard.start();

        expect(scope.concludeIfCurrent()).toBe(true);
        expect(scope.concludeIfCurrent()).toBe(false);
    });

    test('Should keep independently-created guards from sharing any state', () => {
        const guardA = createEpochGuard();
        const guardB = createEpochGuard();

        const scopeA = guardA.start();
        const scopeB = guardB.start();

        guardA.start();
        expect(scopeA.isCurrent()).toBe(false);
        expect(scopeB.isCurrent()).toBe(true);
    });
});
