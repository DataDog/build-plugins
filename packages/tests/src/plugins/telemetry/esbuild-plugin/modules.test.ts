// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { LocalModule } from '@dd/core/types';
import { getModulesResults } from '@dd/telemetry-plugins/common/modules';
import { mockMetaFile } from '@dd/tests/testHelpers';

describe('Telemetry ESBuild Modules', () => {
    test('It should add module size to the results', () => {
        const results = getModulesResults('', mockMetaFile);
        for (const module of Object.values(results) as LocalModule[]) {
            expect(module.size).toBeDefined();
        }
    });

    test('It should add chunkNames to the results', () => {
        const results = getModulesResults('', mockMetaFile);
        for (const module of Object.values(results) as LocalModule[]) {
            expect(module.chunkNames.length).not.toBe(0);
        }
    });
});
