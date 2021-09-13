// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { BuildPlugin } from '../../webpack';
import { mockCompiler } from '../helpers/testHelpers';

type ConsoleError = (message?: any, ...optionalParams: any[]) => void;

describe('webpack', () => {
    test('It should initialise correctly', () => {
        const plugin = new BuildPlugin();
        expect(plugin.name).toBe('BuildPlugin');
        expect(plugin.hooks.length).toBe(3);
    });

    test('It should register custom hooks', () => {
        const plugin = new BuildPlugin({
            hooks: ['./src/__tests__/mocks/customHook.ts'],
        });

        expect(plugin.hooks.length).toBe(4);
        expect(typeof plugin.hooks[3].hooks.preoutput).toBe('function');
    });

    test(`It should use given context or default to webpack's configuration`, () => {
        const plugin1 = new BuildPlugin({
            context: '/fake/path',
        });
        const plugin2 = new BuildPlugin();

        const executePlugin = (plugin: BuildPlugin) => {
            plugin.apply(mockCompiler);
        };

        executePlugin(plugin1);
        executePlugin(plugin2);

        expect(plugin1.options.context).toBe('/fake/path');
        expect(plugin2.options.context).toBe('/default/context');
    });

    test('It should log, given a broken hook path', () => {
        console.error = (jest
            .spyOn(console, 'error')
            .mockImplementation(
                (message?: any, ...optionalParams: any[]) => {}
            ) as unknown) as ConsoleError;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const plugin = new BuildPlugin({
            hooks: ['./broken/path.ts'],
        });

        expect(console.error).toHaveBeenCalledTimes(1);
    });

    test('It should not execute if disabled', () => {
        const compiler = {
            hooks: {
                thisCompilation: {
                    tap: jest.fn(),
                },
            },
        };
        const plugin = new BuildPlugin({
            disabled: true,
        });

        // @ts-ignore
        plugin.apply(compiler);

        expect(compiler.hooks.thisCompilation.tap).not.toHaveBeenCalled();
    });
});
