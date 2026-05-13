// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseAst } from 'rollup/parseAst';

import { createBackendModuleGraphCollector } from './backend-module-graph-collector';

describe('Backend Functions - backend module graph collector', () => {
    test('Should collect parsed local module records from Rollup moduleParsed hooks', () => {
        const collector = createBackendModuleGraphCollector('/project');
        const moduleParsed = collector.plugin.moduleParsed as (moduleInfo: unknown) => void;

        moduleParsed({
            id: '/project/src/backend/actions.backend.js?import',
            ast: parseAst(`
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `),
            importedIds: ['/project/src/backend/helpers/http.js?import'],
            importedIdResolutions: [{ id: '/project/src/backend/helpers/http.js?import' }],
        });
        moduleParsed({
            id: '/project/node_modules/package/index.js',
            ast: parseAst('export const value = true;'),
            importedIds: [],
            importedIdResolutions: [],
        });
        moduleParsed({
            id: '\0virtual-helper.js',
            ast: parseAst('export const value = true;'),
            importedIds: [],
            importedIdResolutions: [],
        });
        moduleParsed({
            id: 'virtual:dd-backend-dev:example.js',
            ast: parseAst('export const value = true;'),
            importedIds: [],
            importedIdResolutions: [],
        });

        expect([...collector.getModuleRecords().keys()]).toEqual([
            '/project/src/backend/actions.backend.js',
        ]);
        expect(
            collector.getModuleRecords().get('/project/src/backend/actions.backend.js'),
        ).toMatchObject({
            staticDependencies: [
                {
                    source: './helpers/http.js',
                    resolvedId: '/project/src/backend/helpers/http.js',
                },
            ],
        });
    });
});
