// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

import { createParsedModuleRecord } from '../backend/ast-parsing/module-graph';
import type { ParsedModuleRecord } from '../backend/ast-parsing/module-graph';

import { createActionCatalogFqnCollector } from './action-catalog-fqn-collector';

const PACKAGE_MODULE_ID =
    '/project/node_modules/@datadog/action-catalog/dist/integrations/http/http.js';
const PACKAGE_MODULE_CODE =
    'import{executeAction as t}from"../../action-execution";function o(e){return t("com.datadoghq.http.request",e)}export{o as request};';

const APP_MODULE_ID = '/project/backend/catalog.js';

function createCollector(moduleRecords: ReadonlyMap<string, ParsedModuleRecord> = new Map()) {
    const logger = getMockLogger();
    return createActionCatalogFqnCollector(logger, () => moduleRecords);
}

function emit(
    collector: ReturnType<typeof createActionCatalogFqnCollector>,
    moduleInfo: { id: string; code: string | null },
) {
    const hook = collector.plugin.moduleParsed;
    if (typeof hook !== 'function') {
        throw new Error('Expected "moduleParsed" to be a function hook.');
    }
    const parse = jest.fn(parseAst);
    Reflect.apply(hook, { parse }, [moduleInfo]);
    return parse;
}

describe('Backend Functions - createActionCatalogFqnCollector', () => {
    test('Should record the export fqns of a package module, keyed by its normalized id', () => {
        const collector = createCollector();

        emit(collector, { id: `${PACKAGE_MODULE_ID}?v=1`, code: PACKAGE_MODULE_CODE });

        const exportFqnsByModule = collector.getExportFqnsByModule();
        const expectedFqns = new Map([['request', 'com.datadoghq.http.request']]);
        const expectedExportFqnsByModule = new Map([[PACKAGE_MODULE_ID, expectedFqns]]);
        expect(exportFqnsByModule).toEqual(expectedExportFqnsByModule);
    });

    const skippedCases = [
        {
            description: 'a virtual module',
            moduleInfo: { id: '\0virtual:entry', code: PACKAGE_MODULE_CODE },
        },
        {
            description: 'a module without source',
            moduleInfo: { id: PACKAGE_MODULE_ID, code: null },
        },
        {
            description: 'a module that names no action',
            moduleInfo: { id: PACKAGE_MODULE_ID, code: 'export const value = 1;' },
        },
    ];

    test.each(skippedCases)('Should not parse $description', ({ moduleInfo }) => {
        const collector = createCollector();

        const parse = emit(collector, moduleInfo);

        expect(parse).not.toHaveBeenCalled();
        const exportFqnsByModule = collector.getExportFqnsByModule();
        expect(exportFqnsByModule.size).toBe(0);
    });

    test('Should skip an unparseable package module instead of failing the build, logging its id', () => {
        mockLogFn.mockClear();
        const collector = createCollector();

        expect(() =>
            emit(collector, { id: PACKAGE_MODULE_ID, code: 'export {{ "com.datadoghq.x.y"' }),
        ).not.toThrow();
        const exportFqnsByModule = collector.getExportFqnsByModule();
        expect(exportFqnsByModule.size).toBe(0);
        const expectedLogMessage = expect.stringContaining(PACKAGE_MODULE_ID);
        expect(mockLogFn).toHaveBeenCalledWith(expectedLogMessage, 'debug');
    });

    test("Should reuse an app module's collected record instead of parsing it again", () => {
        const appModuleCode =
            'function o(e){return run("com.datadoghq.http.request",e)}export{o as request};';
        const program = parseAst(appModuleCode);
        const record = createParsedModuleRecord(APP_MODULE_ID, '/project', program, []);
        if (!record) {
            throw new Error('Expected a record for an app module.');
        }
        const moduleRecords = new Map([[APP_MODULE_ID, record]]);
        const collector = createCollector(moduleRecords);

        const parse = emit(collector, { id: APP_MODULE_ID, code: appModuleCode });

        expect(parse).not.toHaveBeenCalled();
        const expectedFqns = new Map([['request', 'com.datadoghq.http.request']]);
        const exportFqnsByModule = collector.getExportFqnsByModule();
        const expectedExportFqnsByModule = new Map([[APP_MODULE_ID, expectedFqns]]);
        expect(exportFqnsByModule).toEqual(expectedExportFqnsByModule);
    });
});
