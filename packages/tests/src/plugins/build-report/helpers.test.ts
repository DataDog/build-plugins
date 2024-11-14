// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getType } from '@dd/internal-build-report-plugin/helpers';

describe('Build report plugin helpers', () => {
    describe('getType', () => {
        const expectations = [
            ['unknown', 'unknown'],
            ['webpack/runtime', 'runtime'],
            ['path/to/file.js', 'js'],
            [
                '/loaders/load.js??ref--4-0!/tests/_virtual_.%2Fsrc%2Ffixtures%2Fproject%2Fmain1.js%3Fadd-custom-injection',
                'js',
            ],
        ];
        test.each(expectations)('Should return the right type for "%s".', (filepath, type) => {
            expect(getType(filepath)).toBe(type);
        });
    });
});
