import { getPlugins } from '@dd/telemetry-plugins';
import { defaultPluginOptions, runBundlers } from '@dd/tests/helpers';
import fs from 'fs';
import path from 'path';

jest.mock('@dd/telemetry-plugins', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins');
    return {
        ...originalModule,
        getPlugins: jest.fn(() => []),
    };
});

const entry = '@dd/tests/fixtures/index.js';
const destination = path.resolve(__dirname, './dist');
const getPluginsMocked = jest.mocked(getPlugins);

describe('Cross Helpers', () => {
    afterEach(() => {
        // Clean files
        fs.rmSync(destination, {
            recursive: true,
            force: true,
        });
    });
    test('It should inject context in the other plugins.', async () => {
        const pluginConfig = {
            ...defaultPluginOptions,
            telemetry: {},
        };
        await runBundlers({ entry, destination }, pluginConfig);

        // Confirm every call shares the options and the global context
        for (const call of getPluginsMocked.mock.calls) {
            console.log(call);
            expect(call[0]).toEqual(pluginConfig);
            expect(call[1]).toEqual({
                cwd: expect.any(String),
                version: expect.any(String),
                bundler: {
                    name: expect.any(String),
                    config: expect.any(Object),
                },
            });
        }
    });
});
