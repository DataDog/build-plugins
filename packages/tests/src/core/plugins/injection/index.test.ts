import type { Options } from '@dd/core/types';
import { defaultDestination, getComplexBuildOverrides } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import { readFileSync } from 'fs';
import nock from 'nock';
import path from 'path';

describe('Injection Plugin', () => {
    const distantFileContent = 'console.log("Hello injection from distant file.");';
    const localFileContent = 'console.log("Hello injection from local file.");';
    const codeContent = 'console.log("Hello injection from code.");';

    const customPlugins: Options['customPlugins'] = (opts, context) => {
        context.inject({
            type: 'file',
            value: 'https://example.com/distant-file.js',
        });
        context.inject({
            type: 'file',
            value: './src/fixtures/file-to-inject.js',
        });
        context.inject({
            type: 'code',
            value: codeContent,
        });

        return [];
    };

    describe('Basic build', () => {
        let nockScope: nock.Scope;
        beforeAll(async () => {
            nockScope = nock('https://example.com')
                .get('/distant-file.js')
                .times(BUNDLERS.length)
                .reply(200, distantFileContent);

            await runBundlers({
                customPlugins,
            });
        });

        test('Should have requested the distant file for each bundler.', () => {
            expect(nockScope.isDone()).toBe(true);
        });

        describe.each(BUNDLERS)('$name | $version', ({ name }) => {
            test.each([
                { type: 'some string', content: codeContent },
                { type: 'a local file', content: localFileContent },
                { type: 'a distant file', content: distantFileContent },
            ])('Should inject $type once.', ({ content }) => {
                const mainContent = readFileSync(
                    path.resolve(defaultDestination, name, 'main.js'),
                    'utf8',
                );
                expect(mainContent).toEqual(expect.stringContaining(content));
            });
        });
    });

    describe('Complex build', () => {
        let nockScope: nock.Scope;
        beforeAll(async () => {
            nockScope = nock('https://example.com')
                .get('/distant-file.js')
                .times(BUNDLERS.length)
                .reply(200, distantFileContent);

            await runBundlers(
                {
                    customPlugins,
                },
                getComplexBuildOverrides(),
            );
        });

        test('Should have requested the distant file for each bundler.', () => {
            expect(nockScope.isDone()).toBe(true);
        });

        describe.each(BUNDLERS)('$name | $version', ({ name }) => {
            test.each([
                { type: 'some string', content: codeContent },
                { type: 'a local file', content: localFileContent },
                { type: 'a distant file', content: distantFileContent },
            ])('Should inject $type.', ({ content }) => {
                const mainContent = readFileSync(
                    path.resolve(defaultDestination, name, 'main.js'),
                    'utf8',
                );
                expect(mainContent).toEqual(expect.stringContaining(content));
            });
        });
    });
});
