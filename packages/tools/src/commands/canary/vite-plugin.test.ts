// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getCanaryViteConfig,
    getPeerDependencySpecifiers,
    getViteBuildEnvironment,
    hasDependency,
} from './vite-plugin';

describe('Vite plugin canary helpers', () => {
    test('should install the Live Debugger peer dependencies at their declared ranges', () => {
        const packageJson = {
            peerDependencies: {
                '@babel/parser': '^7.24.5',
                '@babel/traverse': '^7.24.5',
                '@babel/types': '^7.24.5',
                vite: '>= 5.x <= 8.x',
            },
        };

        expect(getPeerDependencySpecifiers(packageJson)).toEqual([
            '@babel/parser@^7.24.5',
            '@babel/traverse@^7.24.5',
            '@babel/types@^7.24.5',
        ]);
    });

    test('should fail when a Live Debugger peer dependency is not declared', () => {
        const packageJson = {
            peerDependencies: {
                '@babel/parser': '^7.24.5',
            },
        };

        expect(() => getPeerDependencySpecifiers(packageJson)).toThrow(
            'does not declare a peer dependency on @babel/traverse',
        );
    });

    const dependencyCases = [
        {
            description: 'find a runtime dependency',
            packageJson: { dependencies: { '@datadog/vite-plugin': '3.3.1' } },
            expected: true,
        },
        {
            description: 'find a development dependency',
            packageJson: { devDependencies: { '@datadog/vite-plugin': '3.3.1' } },
            expected: true,
        },
        {
            description: 'ignore a peer dependency',
            packageJson: { peerDependencies: { '@datadog/vite-plugin': '3.x' } },
            expected: false,
        },
    ];

    test.each(dependencyCases)('should $description', ({ packageJson, expected }) => {
        expect(hasDependency(packageJson, '@datadog/vite-plugin')).toBe(expected);
    });

    const getChangedVariables = (
        from: Record<string, string | undefined>,
        to: Record<string, string | undefined>,
    ): string[] => {
        return Object.keys(to).filter((name) => to[name] !== from[name]);
    };

    test('should read the variables that switch Live Debugger settings between variants', () => {
        const config = getCanaryViteConfig('./vite.config.mts');
        const control = getViteBuildEnvironment('control');
        const allFunctions = getViteBuildEnvironment('all-functions');
        const namedOnly = getViteBuildEnvironment('named-only');

        expect(getChangedVariables(control, allFunctions)).toEqual(['BUILD_PLUGIN_LIVE_DEBUGGER']);
        expect(getChangedVariables(allFunctions, namedOnly)).toEqual([
            'BUILD_PLUGIN_LIVE_DEBUGGER_NAMED_ONLY',
        ]);
        expect(config).toContain("enable: process.env.BUILD_PLUGIN_LIVE_DEBUGGER === 'true'");
        expect(config).toContain(
            "namedOnly: process.env.BUILD_PLUGIN_LIVE_DEBUGGER_NAMED_ONLY === 'true'",
        );
        expect(config).toContain("import baseConfig from './vite.config.mts';");
    });
});
