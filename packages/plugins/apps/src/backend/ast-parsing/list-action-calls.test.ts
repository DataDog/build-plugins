// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createFixtureRecord } from '@dd/tests/_jest/helpers/moduleGraph';

import type { DebugBundleAction } from '../protocol';

import { collectActionCatalogCalls } from './extract-connection-ids-from-module-graph';
import { listActionCalls } from './list-action-calls';
import type { ParsedModuleRecord } from './module-graph';

const buildRoot = '/project';
const entryId = '/project/src/backend/actions.backend.js';
const helperId = '/project/src/backend/helpers/slack.js';
const HTTP_MODULE = '@datadog/action-catalog/http/http';
const ROOT_MODULE = '@datadog/action-catalog';

const exportFqnsByModule = new Map([
    [HTTP_MODULE, new Map([['request', 'com.datadoghq.http.request']])],
    [ROOT_MODULE, new Map([['sendSlackMessage', 'com.datadoghq.slack.chat.postMessage']])],
]);

const createRecord = (id: string, code: string, resolvedIds: string[] = []): ParsedModuleRecord =>
    createFixtureRecord(id, buildRoot, code, resolvedIds);

function extract(
    records: ParsedModuleRecord[],
    fqns: ReadonlyMap<string, ReadonlyMap<string, string>> = exportFqnsByModule,
): DebugBundleAction[] | undefined {
    const moduleEntries = records.map((record): [string, ParsedModuleRecord] => [
        record.id,
        record,
    ]);
    const modules = new Map(moduleEntries);
    const calls = collectActionCatalogCalls(entryId, modules, buildRoot);
    return listActionCalls(calls, fqns);
}

describe('Backend Functions - listActionCalls', () => {
    test('Should list named and namespace action-catalog calls across helpers, ordered by fqn', () => {
        const entry = createRecord(
            entryId,
            `
                import { notify } from './helpers/slack.js';
                import * as http from '@datadog/action-catalog/http/http';

                export async function run() {
                    await http.request({ connectionId: 'conn-http', inputs: {} });
                    return notify();
                }
            `,
            [helperId, HTTP_MODULE],
        );
        const helper = createRecord(
            helperId,
            `
                import { sendSlackMessage } from '@datadog/action-catalog';

                export function notify() {
                    return sendSlackMessage({ connectionId: 'conn-slack', inputs: {} });
                }
            `,
            [ROOT_MODULE],
        );

        const actions = extract([entry, helper]);
        expect(actions).toEqual([
            { fqn: 'com.datadoghq.http.request', connectionIds: ['conn-http'] },
            { fqn: 'com.datadoghq.slack.chat.postMessage', connectionIds: ['conn-slack'] },
        ]);
    });

    test('Should merge repeated calls to one action and keep calls with no connectionId', () => {
        const entry = createRecord(
            entryId,
            `
                import { request as callHttp } from '@datadog/action-catalog/http/http';
                import { sendSlackMessage } from '@datadog/action-catalog';

                export function run() {
                    callHttp({ connectionId: 'conn-b', inputs: {} });
                    callHttp({ connectionId: 'conn-a', inputs: {} });
                    callHttp({ connectionId: 'conn-b', inputs: {} });
                    return sendSlackMessage({ inputs: {} });
                }
            `,
            [HTTP_MODULE, ROOT_MODULE],
        );

        const actions = extract([entry]);
        expect(actions).toEqual([
            { fqn: 'com.datadoghq.http.request', connectionIds: ['conn-a', 'conn-b'] },
            { fqn: 'com.datadoghq.slack.chat.postMessage', connectionIds: [] },
        ]);
    });

    test('Should return an empty list for a function with no action-catalog calls', () => {
        const entry = createRecord(entryId, 'export function run() { return 1; }');

        const actions = extract([entry]);
        expect(actions).toEqual([]);
    });

    const unresolvedCases = [
        {
            description: 'the imported package module has no export table',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                export function run() { return request({ inputs: {} }); }
            `,
            fqns: new Map(),
        },
        {
            description: 'the imported export has no known fqn',
            code: `
                import { getChecksumFromURL } from '@datadog/action-catalog/http/http';
                export function run() { return getChecksumFromURL({ inputs: {} }); }
            `,
            fqns: exportFqnsByModule,
        },
        {
            description: 'a namespace call goes through a nested member',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                export function run() { return http.request.call({ inputs: {} }); }
            `,
            fqns: exportFqnsByModule,
        },
        {
            description: 'the action is a default import',
            code: `
                import request from '@datadog/action-catalog/http/http';
                export function run() { return request({ inputs: {} }); }
            `,
            fqns: exportFqnsByModule,
        },
    ];

    test.each(unresolvedCases)('Should return undefined when $description', ({ code, fqns }) => {
        const entry = createRecord(entryId, code, [HTTP_MODULE]);

        const actions = extract([entry], fqns);
        expect(actions).toBeUndefined();
    });
});
