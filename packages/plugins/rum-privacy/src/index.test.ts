import { getPlugins } from '@dd/rum-privacy-plugin';
import { getGetPluginsArg, getContextMock } from '@dd/tests/_jest/helpers/mocks';

describe('Rum Privacy Plugin', () => {
    describe('getPlugins', () => {
        test('Should not initialize the plugin if disabled', async () => {
            expect(getPlugins(getGetPluginsArg({ rumPrivacy: { disabled: true } }))).toHaveLength(
                0,
            );
            expect(
                getPlugins({ options: {}, context: getContextMock(), bundler: {} }),
            ).toHaveLength(0);
        });

        test('Should initialize the plugin if enabled', async () => {
            expect(getPlugins(getGetPluginsArg({ rumPrivacy: { disabled: false } }))).toHaveLength(
                0,
            );
        });
    });
});
