// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseAst } from 'rollup/parseAst';

import { collectActionCatalogExportFqns } from './action-catalog-fqns';
import { ensureProgram } from './type-guards';

function collect(code: string): Record<string, string> {
    const ast = parseAst(code);
    const program = ensureProgram(ast, 'fixture.js');
    const fqnsByExport = collectActionCatalogExportFqns(program);
    return Object.fromEntries(fqnsByExport);
}

describe('Backend Functions - collectActionCatalogExportFqns', () => {
    const cases: { description: string; code: string; expected: Record<string, string> }[] = [
        {
            description: "map each export of the published package's minified module shape",
            code: 'import{executeAction as t}from"../../action-execution";function r(e){return t("com.datadoghq.http.getChecksumFromURL",e)}function o(e){return t("com.datadoghq.http.request",e)}export{r as getChecksumFromURL,o as request};',
            expected: {
                getChecksumFromURL: 'com.datadoghq.http.getChecksumFromURL',
                request: 'com.datadoghq.http.request',
            },
        },
        {
            description: 'map an exported async function declaration',
            code: `
                import { getExecuteActionImplementation } from './action-execution.js';
                export async function sendSlackMessage(request) {
                    const implementation = getExecuteActionImplementation();
                    if (!implementation) {
                        throw new Error('no implementation');
                    }
                    return implementation('com.datadoghq.slack.chat.postMessage', request);
                }
            `,
            expected: { sendSlackMessage: 'com.datadoghq.slack.chat.postMessage' },
        },
        {
            description: 'map exported const arrow and function expressions',
            code: `
                import { executeAction } from './action-execution.js';
                export const listObjects = (e) => executeAction('com.datadoghq.aws.s3.listObjects', e);
                const deleteChat = function (e) { return executeAction('com.datadoghq.slack.chat.deleteChat', e); };
                export { deleteChat };
            `,
            expected: {
                deleteChat: 'com.datadoghq.slack.chat.deleteChat',
                listObjects: 'com.datadoghq.aws.s3.listObjects',
            },
        },
        {
            description: 'skip a function calling more than one distinct action',
            code: `
                export function both(e) {
                    run('com.datadoghq.http.request', e);
                    return run('com.datadoghq.slack.chat.postMessage', e);
                }
            `,
            expected: {},
        },
        {
            description: 'skip a function whose first call argument is not an action id',
            code: `
                export function notAnAction(e) { return run('slack.chat.postMessage', e); }
                export function dynamic(name, e) { return run(name, e); }
            `,
            expected: {},
        },
        {
            description: 'skip re-exports, default exports and non-function exports',
            code: `
                export { request } from './http.js';
                export * from './slack.js';
                export default function (e) { return run('com.datadoghq.http.request', e); }
                export const FQN = 'com.datadoghq.http.request';
                let mutable = (e) => run('com.datadoghq.http.request', e);
                export { mutable };
            `,
            expected: {},
        },
    ];

    test.each(cases)('Should $description', ({ code, expected }) => {
        const fqnsByExport = collect(code);
        expect(fqnsByExport).toEqual(expected);
    });
});
