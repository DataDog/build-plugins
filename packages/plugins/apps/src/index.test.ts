// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/apps-plugin';
import { getGetPluginsArg } from '@dd/tests/_jest/helpers/mocks';

describe('Apps Plugin', () => {
    describe('getPlugins', () => {
        test('Should not initialize the plugin if not enabled', async () => {
            expect(getPlugins(getGetPluginsArg({ apps: { enable: false } }))).toHaveLength(0);
            expect(getPlugins(getGetPluginsArg())).toHaveLength(0);
        });

        test('Should initialize the plugin if enabled', async () => {
            expect(getPlugins(getGetPluginsArg({ apps: { enable: true } }))).toHaveLength(1);
        });
    });
});
