// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { LocalModule } from '@datadog/build-plugins-core/types';
import { getModulesResults } from '../../esbuild/modules';
import { mockLocalOptions, mockMetaFile } from '@datadog/build-plugins-core/testHelpers';

describe('esbuild modules', () => {
    test('It should add module size to the results', () => {
        const results = getModulesResults(mockLocalOptions, mockMetaFile);
        for (const module of Object.values(results) as LocalModule[]) {
            expect(module.size).toBeDefined();
        }
    });

    test('It should add chunkNames to the results', () => {
        const results = getModulesResults(mockLocalOptions, mockMetaFile);
        for (const module of Object.values(results) as LocalModule[]) {
            expect(module.chunkNames.length).not.toBe(0);
        }
    });
});
