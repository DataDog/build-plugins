// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';

import { validateOptions } from '../validate';

import { createTagSources, resolveTags } from './index';

describe('Apps Plugin - tags', () => {
    const context = {
        options: validateOptions({ apps: { tags: ['team:apps', 'surface:datadog.dashboard'] } }),
        log: getMockLogger(),
    };
    const readChunk = (sources: ReturnType<typeof createTagSources>, code: string) => {
        for (const source of sources) {
            source.readChunk?.({ fileName: 'index.js', code });
        }
    };

    test('Should combine every source into one normalized, deduplicated, sorted list', () => {
        const sources = [
            ...createTagSources(context),
            { tags: () => [' Env:Prod ', 'team:apps', ''] },
        ];
        readChunk(sources, 'f("dd-app-input/v1 datadog.dashboard surfaces=datadog.dashboard")');

        expect(resolveTags(sources)).toEqual([
            'env:prod',
            'surface:datadog.dashboard',
            'team:apps',
        ]);
    });

    test("Should not carry one build's derived tags into the next build's sources", () => {
        readChunk(
            createTagSources(context),
            'f("dd-app-input/v1 datadog.idp surfaces=datadog.idp")',
        );

        expect(resolveTags(createTagSources(context))).toEqual([
            'surface:datadog.dashboard',
            'team:apps',
        ]);
    });
});
