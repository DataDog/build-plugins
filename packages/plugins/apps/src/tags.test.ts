// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readInputMarkers } from './tags';

describe('Apps Plugin - readInputMarkers', () => {
    const cases = [
        {
            description: 'read markers in any quote style, several per chunk, in order',
            code:
                'var a=f("dd-app-input/v1 datadog.dashboard surfaces=datadog.dashboard,datadog.notebook"),' +
                "b=f('dd-app-input/v1 datadog.idp surfaces=datadog.idp.service-panel')," +
                'c=f(`dd-app-input/v1 datadog.x_y surfaces=datadog.x_y`);',
            expected: {
                surfaces: [
                    'datadog.dashboard',
                    'datadog.notebook',
                    'datadog.idp.service-panel',
                    'datadog.x_y',
                ],
                unrecognized: [],
            },
        },
        {
            description: 'read an input that declares no surfaces as contributing none',
            code: 'f("dd-app-input/v1 datadog.theme surfaces=")',
            expected: { surfaces: [], unrecognized: [] },
        },
        {
            description: 'report, rather than truncate, markers outside the v1 grammar',
            code:
                'f("dd-app-input/v1 datadog.dashboard surfaces=datadog.dashboard extra=1");' +
                'g("dd-app-input/v2 datadog.dashboard surfaces=datadog.dashboard");' +
                'h("dd-app-input/v1 datadog.theme surfaces=")',
            expected: {
                surfaces: [],
                unrecognized: [
                    'dd-app-input/v1 datadog.dashboard surfaces=datadog.dashboard extra=1',
                    'dd-app-input/v2 datadog.dashboard surfaces=datadog.dashboard',
                ],
            },
        },
        {
            description: 'find nothing in code without markers',
            code: 'console.log("dd-app"+"input")',
            expected: { surfaces: [], unrecognized: [] },
        },
    ];

    test.each(cases)('Should $description', ({ code, expected }) => {
        expect(readInputMarkers(code)).toEqual(expected);
    });
});
