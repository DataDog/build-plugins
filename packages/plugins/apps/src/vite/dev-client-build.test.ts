// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEV_CLIENT_HOOK } from '@dd/apps-plugin/backend/protocol';
import { build } from 'esbuild';
import path from 'path';
import vm from 'vm';

describe('apps-dev-client entry', () => {
    test('Should install the dev client hook when the bundled entry runs', async () => {
        const entryPoint = path.join(__dirname, '../built/apps-dev-client.ts');
        const result = await build({
            entryPoints: [entryPoint],
            bundle: true,
            format: 'esm',
            platform: 'browser',
            write: false,
        });
        const [output] = result.outputFiles;
        const sandbox = vm.createContext({});

        vm.runInContext(output.text, sandbox);

        const hook: unknown = Reflect.get(sandbox, DEV_CLIENT_HOOK);
        expect(typeof hook).toBe('function');
    });
});
