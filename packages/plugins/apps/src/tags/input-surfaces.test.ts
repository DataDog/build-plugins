// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';

import type { AppsOptionsWithDefaults } from '../types';

import { inputSurfaceTagSource } from './input-surfaces';

describe('Apps Plugin - input surface tags', () => {
    const cases = [
        {
            description: 'tag every surface of markers in any quote style, several per chunk',
            chunks: [
                'var a=f("dd-app-input/v1 datadog.dashboard surfaces=datadog.dashboard,datadog.notebook"),' +
                    "b=f('dd-app-input/v1 datadog.idp surfaces=datadog.idp.service-panel');",
                'c=f(`dd-app-input/v1 datadog.x_y surfaces=datadog.x_y`);',
            ],
            expected: {
                tags: [
                    'surface:datadog.dashboard',
                    'surface:datadog.notebook',
                    'surface:datadog.idp.service-panel',
                    'surface:datadog.x_y',
                ],
                warnings: 0,
            },
        },
        {
            description: 'add no tag for an input that declares no surfaces',
            chunks: ['f("dd-app-input/v1 datadog.theme surfaces=")'],
            expected: { tags: [], warnings: 0 },
        },
        {
            description: 'warn about, rather than truncate, markers outside the v1 grammar',
            chunks: [
                'f("dd-app-input/v1 datadog.dashboard surfaces=datadog.dashboard extra=1");' +
                    'g("dd-app-input/v2 datadog.dashboard surfaces=datadog.dashboard");' +
                    'h("dd-app-input/v1 datadog.theme surfaces=")',
            ],
            expected: { tags: [], warnings: 2 },
        },
        {
            description: 'add nothing for code without markers',
            chunks: ['console.log("dd-app"+"input")'],
            expected: { tags: [], warnings: 0 },
        },
    ];

    test.each(cases)('Should $description', ({ chunks, expected }) => {
        const warn = jest.fn();
        const source = inputSurfaceTagSource({
            options: {} as AppsOptionsWithDefaults,
            log: getMockLogger({ warn }),
        });

        chunks.forEach((code, index) => source.readChunk!({ fileName: `${index}.js`, code }));

        expect(source.tags()).toEqual(expected.tags);
        expect(warn).toHaveBeenCalledTimes(expected.warnings);
    });
});
