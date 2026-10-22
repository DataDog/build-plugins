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
    return listActionCalls(calls, fqns, modules);
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
            {
                fqn: 'com.datadoghq.http.request',
                connectionIds: ['conn-http'],
                calls: [{ connectionId: 'conn-http', inputs: {} }],
            },
            {
                fqn: 'com.datadoghq.slack.chat.postMessage',
                connectionIds: ['conn-slack'],
                calls: [{ connectionId: 'conn-slack', inputs: {} }],
            },
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
            {
                fqn: 'com.datadoghq.http.request',
                connectionIds: ['conn-a', 'conn-b'],
                calls: [
                    { connectionId: 'conn-b', inputs: {} },
                    { connectionId: 'conn-a', inputs: {} },
                    { connectionId: 'conn-b', inputs: {} },
                ],
            },
            {
                fqn: 'com.datadoghq.slack.chat.postMessage',
                connectionIds: [],
                calls: [{ inputs: {} }],
            },
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

    const listHttpCallInputs = (code: string, helper?: string) => {
        const source = `import { request } from '@datadog/action-catalog/http/http';\n${code}`;
        const helpers = helper ? [createRecord(helperId, helper)] : [];
        const helperIds = helpers.map(({ id }) => id);
        const entry = createRecord(entryId, source, [HTTP_MODULE, ...helperIds]);
        const actions = extract([entry, ...helpers]);
        return actions?.[0].calls.map((call) => call.inputs);
    };

    const inputCases = [
        {
            description: 'string literals',
            code: `request({ inputs: { url: 'https://example.com', verb: 'GET' } });`,
            expected: { url: 'https://example.com', verb: 'GET' },
        },
        {
            description: 'module consts',
            code: `
                const BASE_URL = 'https://example.com';
                const VERB = 'POST';
                request({ inputs: { url: BASE_URL, verb: VERB } });
            `,
            expected: { url: 'https://example.com', verb: 'POST' },
        },
        {
            description: 'a const imported from another module',
            code: `
                import { BASE_URL } from './helpers/slack.js';
                request({ inputs: { url: BASE_URL } });
            `,
            helper: `export const BASE_URL = 'https://example.com/api';`,
            expected: { url: 'https://example.com/api' },
        },
        {
            description: 'an imported const object property, left out',
            code: `
                import { URLS } from './helpers/slack.js';
                request({ inputs: { url: URLS.API, verb: 'GET' } });
            `,
            helper: `export const URLS = { API: 'https://example.com/api' };`,
            expected: { verb: 'GET' },
        },
        {
            description: 'a const object property that an alias mutates, left out',
            code: `
                const URLS = { API: 'https://example.com/api' };
                const alias = URLS;
                alias.API = 'https://other.example';
                request({ inputs: { url: URLS.API, verb: 'GET' } });
            `,
            expected: { verb: 'GET' },
        },
        {
            description: 'a const read from an object a call mutates, left out',
            code: `
                const URLS = { API: 'https://example.com/api' };
                Object.assign(URLS, { API: 'https://other.example' });
                const API_URL = URLS.API;
                request({ inputs: { url: API_URL, verb: 'GET' } });
            `,
            expected: { verb: 'GET' },
        },
        {
            description: 'a template literal with no expressions',
            code: 'request({ inputs: { url: `https://example.com/api`, verb: "GET" } });',
            expected: { url: 'https://example.com/api', verb: 'GET' },
        },
        {
            description: 'a template literal with an expression, left out even over a const',
            code: `
                const HOST = 'example.com';
                request({ inputs: { url: \`https://\${HOST}/api\`, verb: 'GET' } });
            `,
            expected: { verb: 'GET' },
        },
        {
            description: 'dynamic values, left out',
            code: `
                export function run(target, host) {
                    return request({
                        inputs: {
                            url: target,
                            verb: 'GET',
                            body: \`https://\${host}/api\`,
                            timeout: 30,
                            headers: { accept: 'application/json' },
                            parse() { return 'x'; },
                        },
                    });
                }
            `,
            expected: { verb: 'GET' },
        },
        {
            description: 'a spread, which can add a toJSON, leaving out every input',
            code: `
                export function run(extra) {
                    return request({ inputs: { ...extra, url: 'https://a.example' } });
                }
            `,
            expected: {},
        },
        {
            description: 'a computed key, which can add a toJSON, leaving out every input',
            code: `
                export function run(key, toJson) {
                    return request({ inputs: { [key]: toJson, url: 'https://a.example' } });
                }
            `,
            expected: {},
        },
        {
            description: 'a getter, which can rewrite other inputs, leaving out every input',
            code: `
                request({
                    inputs: {
                        get verb() { this.url = 'https://other.example'; return 'GET'; },
                        url: 'https://a.example',
                    },
                });
            `,
            expected: {},
        },
        {
            description: 'a toJSON method, leaving out every input',
            code: `
                request({
                    inputs: {
                        url: 'https://a.example',
                        toJSON() { return { url: 'https://other.example' }; },
                    },
                });
            `,
            expected: {},
        },
        {
            description: 'a then method, which awaiting the inputs runs, leaving out every input',
            code: `
                request({
                    inputs: {
                        url: 'https://a.example',
                        then(resolve) { this.url = 'https://other.example'; resolve({}); },
                    },
                });
            `,
            expected: {},
        },
        {
            description: 'a getter on the call options, leaving out every input',
            code: `
                request({
                    get extra() { this.inputs.url = 'https://other.example'; return 1; },
                    inputs: { url: 'https://a.example' },
                });
            `,
            expected: {},
        },
        {
            description: 'a setter, leaving out every input',
            code: `request({ inputs: { set url(value) {}, verb: 'GET' } });`,
            expected: {},
        },
        {
            description: 'a numeric key, which only sets its own key',
            code: `request({ inputs: { url: 'https://a.example', 0: 'zero', 1: 2 } });`,
            expected: { url: 'https://a.example', 0: 'zero' },
        },
        {
            description: 'a duplicate key whose last value is dynamic',
            code: `
                export function run(target) {
                    return request({ inputs: { url: 'https://a.example', url: target } });
                }
            `,
            expected: {},
        },
        {
            description: 'a duplicate key whose last value is static',
            code: `
                export function run(target) {
                    return request({ inputs: { url: target, url: 'https://b.example' } });
                }
            `,
            expected: { url: 'https://b.example' },
        },
        {
            description: 'a __proto__ key, which can inherit a toJSON, leaving out every input',
            code: `
                const PROTO = { toJSON: () => ({ url: 'https://other.example' }) };
                request({ inputs: { __proto__: PROTO, url: 'https://a.example' } });
            `,
            expected: {},
        },
        {
            description: 'inputs that are not an inline object',
            code: `
                const INPUTS = { url: 'https://example.com' };
                request({ inputs: INPUTS });
            `,
            expected: {},
        },
        {
            description: 'no inputs',
            code: `request({ connectionId: 'conn-http' });`,
            expected: {},
        },
    ];

    test.each(inputCases)(
        "Should list each call's static string inputs from $description",
        ({ code, helper, expected }) => {
            const inputs = listHttpCallInputs(code, helper);
            expect(inputs).toEqual([expected]);
        },
    );

    const rejectedOptionCases = [
        {
            description: 'a toJSON',
            code: `
                request({
                    inputs: { url: 'https://a.example' },
                    toJSON: () => ({ inputs: { url: 'https://other.example' } }),
                });
            `,
        },
        {
            description: 'a __proto__ key',
            code: `
                const PROTO = { toJSON: () => ({ inputs: { url: 'https://other.example' } }) };
                request({ __proto__: PROTO, inputs: { url: 'https://a.example' } });
            `,
        },
    ];

    test.each(rejectedOptionCases)(
        'Should reject a call whose options have $description before listing its inputs',
        ({ code }) => {
            expect(() => listHttpCallInputs(code)).toThrow('could hide a connectionId');
        },
    );

    test('Should list each call separately, with its own connectionId', () => {
        const entry = createRecord(
            entryId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                export function run() {
                    request({ connectionId: 'conn-b', inputs: { url: 'https://b.example', verb: 'POST' } });
                    request({ inputs: { url: 'https://a.example', verb: 'GET' } });
                }
            `,
            [HTTP_MODULE],
        );

        const actions = extract([entry]);
        expect(actions?.[0].calls).toEqual([
            { connectionId: 'conn-b', inputs: { url: 'https://b.example', verb: 'POST' } },
            { inputs: { url: 'https://a.example', verb: 'GET' } },
        ]);
    });

    test('Should keep an empty-string connectionId on its call', () => {
        const entry = createRecord(
            entryId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                export function run() { return request({ connectionId: '', inputs: {} }); }
            `,
            [HTTP_MODULE],
        );

        const actions = extract([entry]);
        expect(actions?.[0].calls).toEqual([{ connectionId: '', inputs: {} }]);
    });
});
