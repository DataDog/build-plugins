// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { BaseClass } from '@datadog/build-plugins-core/BaseClass';

type ConsoleError = (message?: any, ...optionalParams: any[]) => void;

describe('BaseClass', () => {
    test('It should initialise correctly', () => {
        const plugin = new BaseClass();
        expect(plugin.name).toBe('BuildPlugin');
        expect(plugin.hooks.length).toBe(3);
    });

    test('It should register custom hooks', () => {
        const plugin = new BaseClass({
            hooks: ['@datadog/build-plugins-tests/mocks/customHook.ts'],
        });

        expect(plugin.hooks.length).toBe(4);
        expect(typeof plugin.hooks[3].hooks.preoutput).toBe('function');
    });

    test('It should log, given a broken hook path', () => {
        console.error = (jest
            .spyOn(console, 'error')
            .mockImplementation(
                (message?: any, ...optionalParams: any[]) => {}
            ) as unknown) as ConsoleError;

        new BaseClass({
            hooks: ['./broken/path.ts'],
        });

        expect(console.error).toHaveBeenCalledTimes(1);
    });
});
