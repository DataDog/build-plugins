// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Not named `*.test.*`: nockInterceptors.test.ts runs the nockStack fixtures in one process, in name
// order, so nockStackRequest runs after the files that leave a copy of nock behind.
import importedNock from 'nock';

import { getSlotsOffBaseline } from './helpers/sharedHttpPatches';

jest.resetModules();

// Runs after setupAfterEnv's afterAll, which jest-circus calls first because it registered first.
afterAll(() => {
    const offBaseline = getSlotsOffBaseline();
    if (offBaseline.length > 0) {
        const slotList = offBaseline.join(', ');
        throw new Error(`Expected setupAfterEnv's afterAll to put back ${slotList}.`);
    }
});

// Describe bodies also run while the file loads, so this covers a describe-scope reset too.
test('Should keep the imported nock active after a module-scope reset', () => {
    const setupNock = jest.requireActual<typeof import('nock')>('nock');
    const isImportedNockActive = importedNock.isActive();
    expect(setupNock).not.toBe(importedNock);
    expect(isImportedNockActive).toBe(true);
});
