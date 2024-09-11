import { getType } from '@dd/core/plugins/build-report/helpers';

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
        test.each(expectations)('Should return the right type.', (filepath, type) => {
            expect(getType(filepath)).toBe(type);
        });
    });
});
