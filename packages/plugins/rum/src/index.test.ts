// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ToInjectItem } from '@dd/core/types';
import type { RumOptions } from '@dd/rum-plugin/types';
import { getPlugins } from '@dd/rum-plugin';
import {
    defaultPluginOptions,
    getContextMock,
    getGetPluginsArg,
    getMockLogger,
} from '@dd/tests/_jest/helpers/mocks';
import path from 'path';

// Mock getInjectionvalue @dd/rum-plugin/sdk to return a given string.
const injectionValue = 'DD_RUM INITIALIZATION';
jest.mock('@dd/rum-plugin/sdk', () => ({
    getInjectionValue: jest.fn(() => injectionValue),
}));

describe('RUM Plugin', () => {
    const run = (config: RumOptions) => {
        const injectSpy = jest.fn((_item: ToInjectItem) => {});
        getPlugins(
            getGetPluginsArg(
                { ...defaultPluginOptions, rum: config },
                getContextMock({ inject: injectSpy }),
            ),
        );
        return injectSpy.mock.calls.map(([item]) => item.value);
    };

    test('Should inject nothing with no config', () => {
        expect(run({})).toHaveLength(0);
    });

    test('Should not add the early collection plugin by default', () => {
        const plugins = getPlugins(
            getGetPluginsArg({ ...defaultPluginOptions, rum: {} }, getContextMock()),
        );
        expect(plugins).toHaveLength(0);
    });

    test('Should add the early collection plugin when enabled', () => {
        const plugins = getPlugins(
            getGetPluginsArg(
                { ...defaultPluginOptions, rum: { earlyCollection: true } },
                getContextMock(),
            ),
        );
        expect(plugins.map((plugin) => plugin.name)).toEqual([
            'datadog-rum-early-collection-plugin',
        ]);
    });

    test('Should warn that the bundled SDK does not adopt the early collection', () => {
        const warn = jest.fn();
        const log = { ...getMockLogger(), warn };
        const config = { earlyCollection: true, sdk: { applicationId: 'app-id' } };
        getPlugins(
            getGetPluginsArg(
                { ...defaultPluginOptions, rum: config },
                getContextMock({ getLogger: () => log }),
            ),
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('v7.20.0');
    });

    test('Should reject a non boolean earlyCollection', () => {
        expect(() =>
            getPlugins(
                getGetPluginsArg(
                    { ...defaultPluginOptions, rum: { earlyCollection: 'yes' as any } },
                    getContextMock(),
                ),
            ),
        ).toThrow('Invalid configuration');
    });

    test('Should inject SDK files with sdk config', () => {
        const values = run({ sdk: { applicationId: 'app-id' } });
        expect(values).toHaveLength(2);
        expect(values).toContain(path.resolve('../plugins/rum/src/rum-browser-sdk.js'));
        expect(values).toContain(injectionValue);
    });

    test('Should inject source code context snippet', () => {
        const value = run({
            sourceCodeContext: { service: 'checkout', version: '1.2.3' },
        })[0] as () => string;
        expect(value()).toMatch(
            /(?=.*DD_SOURCE_CODE_CONTEXT)(?=.*"service":"checkout")(?=.*"version":"1\.2\.3")/,
        );
    });

    test('Should inject debug id snippet', () => {
        const value = run({ sourceCodeContext: { debugId: true } })[0] as () => string;
        expect(value()).toMatch(/(?=.*DD_SOURCE_CODE_CONTEXT)(?=.*"ddDebugId":"[0-9a-f-]+")/);
    });

    test('Should not serialize service and version with a debug ID', () => {
        const value = run({ sourceCodeContext: { debugId: true } })[0] as () => string;
        const code = value();

        expect(code).toContain('"ddDebugId"');
        expect(code).not.toContain('"service"');
        expect(code).not.toContain('"version"');
    });

    test('Should serialize service and version alongside a debug ID', () => {
        const value = run({
            sourceCodeContext: {
                debugId: true,
                service: 'checkout',
                version: '1.2.3',
            },
        })[0] as () => string;
        const code = value();

        expect(code).toContain('"ddDebugId"');
        expect(code).toContain('"service":"checkout"');
        expect(code).toContain('"version":"1.2.3"');
    });
});
