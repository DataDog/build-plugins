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
});
