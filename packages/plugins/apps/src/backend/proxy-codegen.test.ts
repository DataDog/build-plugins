// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { generateProxyModule } from '@dd/apps-plugin/backend/proxy-codegen';

describe('Proxy Codegen - generateProxyModule', () => {
    test('Should generate a proxy module that reads executeBackendFunction off the runtime global', () => {
        const result = generateProxyModule([{ exportName: 'add', queryName: 'a1b2c3d4e5f6.add' }]);

        expect(result).toContain('export async function add(...args)');
        expect(result).toContain(
            'globalThis.DD_APPS_RUNTIME.executeBackendFunction("a1b2c3d4e5f6.add", args)',
        );
        expect(result).not.toContain('@datadog/apps-function-query');
        expect(result).not.toContain('virtual:dd-apps-runtime');
        expect(result).not.toMatch(/^\s*import\s/m);
    });

    test('Should generate a proxy module for multiple exports', () => {
        const result = generateProxyModule([
            { exportName: 'add', queryName: 'a1b2c3d4e5f6.add' },
            { exportName: 'multiply', queryName: 'a1b2c3d4e5f6.multiply' },
        ]);

        expect(result).toContain('export async function add(...args)');
        expect(result).toContain('export async function multiply(...args)');
        expect(result).toContain('"a1b2c3d4e5f6.add"');
        expect(result).toContain('"a1b2c3d4e5f6.multiply"');
    });

    test('Should not contain raw backend file paths', () => {
        const result = generateProxyModule([
            { exportName: 'login', queryName: 'deadbeef1234.login' },
        ]);

        // The generated code should only contain the hashed query name,
        // not any path information that reveals backend file structure.
        expect(result).not.toContain('src/features/auth/login');
        expect(result).not.toContain('.backend');
        expect(result).toContain('"deadbeef1234.login"');
    });
});
