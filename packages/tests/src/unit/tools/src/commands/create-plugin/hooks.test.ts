// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { allHookNames } from '@dd/tools/commands/create-plugin/constants';
import { allHooks, getHookTemplate } from '@dd/tools/commands/create-plugin/hooks';

describe('hooks.ts', () => {
    describe('allHooks', () => {
        test.each(allHookNames)('Should have a description for %s.', (hookInput) => {
            const hook = allHooks[hookInput];
            expect(hook).toBeDefined();
            expect(hook.name).toBeTruthy();
            expect(hook.descriptions).toBeDefined();
            expect(hook.descriptions).not.toHaveLength(0);
        });
    });

    describe('getHookTemplate', () => {
        test.each(allHookNames)('Should have a template for %s.', (hookInput) => {
            const template = getHookTemplate(hookInput);
            expect(template).toBeTruthy();
        });
    });
});
