// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { CONNECTION_LABELS_UPGRADE_MESSAGE } from '@dd/apps-plugin/backend/connection-labels';
import * as shared from '@dd/apps-plugin/backend/shared';
import {
    loadConnectionLabelsHelper,
    toConnectionLabelsHelper,
} from '@dd/apps-plugin/vite/connection-labels-helper';
import { FIXTURE_ROOT } from '@dd/apps-plugin/vite/local-execution-process.fixtures';
import fs from 'fs';
import os from 'os';
import path from 'path';

const getResolvedConnectionIds = () => ['conn-a', 42, 'conn-b'];
const validHelper = {
    CONNECTION_LABEL_PATTERN: /^[a-z]+$/,
    getResolvedConnectionIds,
    readResolvedConnections: () => ({}),
    swapConnectionLabel: (request: unknown) => request,
};

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
        {
            description: 'a module without readResolvedConnections, which the entry imports',
            helperModule: { ...validHelper, readResolvedConnections: undefined },
        },
        {
            description: 'a module without swapConnectionLabel, which the entry imports',
            helperModule: { ...validHelper, swapConnectionLabel: 'swap' },
        },
    ];

    test.each(absentCases)('should treat $description as absent', ({ helperModule }) => {
        expect(toConnectionLabelsHelper(helperModule)).toBeUndefined();
    });
});

describe('loadConnectionLabelsHelper', () => {
    const validSource = [
        'export const CONNECTION_LABEL_PATTERN = /^[a-z]+$/;',
        'export const getResolvedConnectionIds = () => [];',
        'export const readResolvedConnections = () => ({});',
        'export const swapConnectionLabel = (request) => request;',
    ].join('\n');
    const brokenSource = 'throw new Error("broken");';
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-apps-labels-helper-'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    const installHelper = (source: string, exportedSubpath = './connection-labels') => {
        const packageDir = path.join(projectRoot, 'node_modules', '@datadog', 'action-catalog');
        fs.mkdirSync(packageDir, { recursive: true });
        const packageJson = {
            name: '@datadog/action-catalog',
            type: 'module',
            exports: { [exportedSubpath]: './connection-labels.js' },
        };
        fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(packageJson));
        fs.writeFileSync(path.join(packageDir, 'connection-labels.js'), source);
    };

    const upgradeRule = { unavailableReason: CONNECTION_LABELS_UPGRADE_MESSAGE };

    test('should load the installed helper', async () => {
        const { helper, labelRule } = await loadConnectionLabelsHelper(FIXTURE_ROOT);
        expect(labelRule).toEqual({ pattern: helper?.connectionLabelPattern });
        expect(helper?.connectionLabelPattern.test('jira')).toBe(true);
        expect(helper?.connectionLabelPattern.test('1bad label')).toBe(false);
        const runtimeContext = { HasConnectionEnvs: true, Connections: { jira: 'conn-a' } };
        expect(helper?.getResolvedConnectionIds(runtimeContext, ['jira'])).toEqual(['conn-a']);
    });

    test('should load a helper installed the same way as the absent cases below', async () => {
        installHelper(validSource);
        const { helper } = await loadConnectionLabelsHelper(projectRoot);
        expect(helper?.connectionLabelPattern.source).toBe('^[a-z]+$');
    });

    const absentCases = [
        { description: 'action-catalog is not installed', source: undefined },
        {
            description: 'an older action-catalog lacks the subpath export',
            source: validSource,
            exportedSubpath: './action-execution',
        },
        {
            description: 'the module lacks an export',
            source: 'export const CONNECTION_LABEL_PATTERN = /^[a-z]+$/;',
        },
    ];

    test.each(absentCases)(
        'should ask for an upgrade when $description',
        async ({ source, exportedSubpath }) => {
            if (source !== undefined) {
                installHelper(source, exportedSubpath);
            }
            await expect(loadConnectionLabelsHelper(projectRoot)).resolves.toEqual({
                helper: undefined,
                labelRule: upgradeRule,
            });
        },
    );

    // Resolves rather than rejects, so only a build with a label call fails on it.
    test('should give the load error of an installed helper that fails to load', async () => {
        installHelper(brokenSource);
        await expect(loadConnectionLabelsHelper(projectRoot)).resolves.toEqual({
            helper: undefined,
            labelRule: {
                unavailableReason: `Couldn't load ${shared.CONNECTION_LABELS_EXPORT}: broken`,
            },
        });
    });

    test('should retry a helper that failed to load on the next load', async () => {
        installHelper(brokenSource);
        const failed = await loadConnectionLabelsHelper(projectRoot);
        expect(failed.helper).toBeUndefined();
        installHelper(validSource);
        const { helper } = await loadConnectionLabelsHelper(projectRoot);
        expect(helper?.connectionLabelPattern.source).toBe('^[a-z]+$');
    });

    test('should retry a helper that was not installed on the next load', async () => {
        installHelper(validSource);
        // Jest's resolver caches a failed lookup, so the first miss is simulated.
        jest.spyOn(shared, 'resolvePackageExport').mockReturnValueOnce(undefined);
        const missing = await loadConnectionLabelsHelper(projectRoot);
        expect(missing.helper).toBeUndefined();
        const { helper } = await loadConnectionLabelsHelper(projectRoot);
        expect(helper?.connectionLabelPattern.source).toBe('^[a-z]+$');
    });

    test('should load a helper that lacks an export only once', async () => {
        const loadCountKey = `__ddLabelsHelperLoads-${path.basename(projectRoot)}`;
        const counter = `globalThis[${JSON.stringify(loadCountKey)}]`;
        installHelper(
            `${counter} = (${counter} ?? 0) + 1;\nexport const CONNECTION_LABEL_PATTERN = /^[a-z]+$/;`,
        );
        await loadConnectionLabelsHelper(projectRoot);
        await loadConnectionLabelsHelper(projectRoot);
        expect(Reflect.get(globalThis, loadCountKey)).toBe(1);
    });

    test('should reuse a loaded helper', async () => {
        installHelper(validSource);
        const first = await loadConnectionLabelsHelper(projectRoot);
        expect(await loadConnectionLabelsHelper(projectRoot)).toBe(first);
    });
});
