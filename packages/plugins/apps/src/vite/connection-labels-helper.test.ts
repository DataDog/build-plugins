// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    loadConnectionLabelsHelper,
    toConnectionLabelsHelper,
} from '@dd/apps-plugin/vite/connection-labels-helper';
import { FIXTURE_ROOT } from '@dd/apps-plugin/vite/local-execution-process.fixtures';
import fs from 'fs';
import os from 'os';
import path from 'path';

const getResolvedConnectionIds = () => ['conn-a', 42, 'conn-b'];
const validHelper = { CONNECTION_LABEL_PATTERN: /^[a-z]+$/, getResolvedConnectionIds };

describe('toConnectionLabelsHelper', () => {
    test('should keep a module with both exports, dropping non-string IDs', () => {
        const helper = toConnectionLabelsHelper(validHelper);
        expect(helper?.connectionLabelPattern).toBe(validHelper.CONNECTION_LABEL_PATTERN);
        expect(helper?.getResolvedConnectionIds({}, ['jira'])).toEqual(['conn-a', 'conn-b']);
    });

    test('should treat a non-array result as no IDs', () => {
        const helper = toConnectionLabelsHelper({
            ...validHelper,
            getResolvedConnectionIds: () => 'conn-a',
        });
        expect(helper?.getResolvedConnectionIds({}, ['jira'])).toEqual([]);
    });

    const absentCases = [
        { description: 'a null module', helperModule: null },
        { description: 'a non-object module', helperModule: 'connection-labels' },
        {
            description: 'a module without the label pattern',
            helperModule: { getResolvedConnectionIds },
        },
        {
            description: 'a label pattern that is a string, not a RegExp',
            helperModule: { ...validHelper, CONNECTION_LABEL_PATTERN: '^[a-z]+$' },
        },
        {
            description: 'a module without getResolvedConnectionIds',
            helperModule: { CONNECTION_LABEL_PATTERN: /^[a-z]+$/ },
        },
        {
            description: 'a getResolvedConnectionIds that is not a function',
            helperModule: { ...validHelper, getResolvedConnectionIds: [] },
        },
    ];

    test.each(absentCases)('should treat $description as absent', ({ helperModule }) => {
        expect(toConnectionLabelsHelper(helperModule)).toBeUndefined();
    });
});

describe('loadConnectionLabelsHelper', () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-apps-labels-helper-'));
    });

    afterEach(() => {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    const installHelper = (source: string) => {
        const packageDir = path.join(projectRoot, 'node_modules', '@datadog', 'action-catalog');
        fs.mkdirSync(packageDir, { recursive: true });
        const packageJson = {
            name: '@datadog/action-catalog',
            type: 'module',
            exports: { './connection-labels': './connection-labels.js' },
        };
        fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(packageJson));
        fs.writeFileSync(path.join(packageDir, 'connection-labels.js'), source);
    };

    test('should load the installed helper', async () => {
        const helper = await loadConnectionLabelsHelper(FIXTURE_ROOT);
        expect(helper?.connectionLabelPattern.test('jira')).toBe(true);
        expect(helper?.connectionLabelPattern.test('1bad label')).toBe(false);
        const runtimeContext = { HasConnectionEnvs: true, Connections: { jira: 'conn-a' } };
        expect(helper?.getResolvedConnectionIds(runtimeContext, ['jira'])).toEqual(['conn-a']);
    });

    test('should load a helper installed the same way as the absent cases below', async () => {
        installHelper(
            'export const CONNECTION_LABEL_PATTERN = /^[a-z]+$/;\nexport const getResolvedConnectionIds = () => [];',
        );
        const helper = await loadConnectionLabelsHelper(projectRoot);
        expect(helper?.connectionLabelPattern.source).toBe('^[a-z]+$');
    });

    const absentCases = [
        { description: 'action-catalog is not installed', source: undefined },
        {
            description: 'the module lacks an export',
            source: 'export const CONNECTION_LABEL_PATTERN = /^[a-z]+$/;',
        },
        { description: 'the module fails to load', source: 'throw new Error("broken");' },
    ];

    test.each(absentCases)('should return nothing when $description', async ({ source }) => {
        if (source !== undefined) {
            installHelper(source);
        }
        await expect(loadConnectionLabelsHelper(projectRoot)).resolves.toBeUndefined();
    });
});
