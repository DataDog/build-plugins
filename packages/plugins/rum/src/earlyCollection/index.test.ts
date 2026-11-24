// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { EARLY_COLLECTION_TAG } from '@dd/rum-plugin/earlyCollection/html';
import { getEarlyCollectionPlugin } from '@dd/rum-plugin/earlyCollection/index';
import { getContextMock, getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HTML = '<html><head><title>a</title></head><body></body></html>';
const INJECTED_HTML = `<html><head>${EARLY_COLLECTION_TAG}<title>a</title></head><body></body></html>`;

describe('Early collection plugin', () => {
    const warn = jest.fn();
    const setup = (bundler: any = {}) => {
        const log = { ...getMockLogger(), warn };
        return getEarlyCollectionPlugin(bundler, getContextMock({ getLogger: () => log }));
    };

    beforeEach(() => {
        warn.mockClear();
    });

    describe('Vite', () => {
        const getVite = (command: string) => {
            const vite: any = setup().vite;
            vite.configResolved({ command });
            return vite;
        };

        test('Should inject the tag before the other plugins', () => {
            const { transformIndexHtml } = getVite('build');
            expect(transformIndexHtml.order).toBe('pre');
            expect(transformIndexHtml.handler(HTML)).toBe(INJECTED_HTML);
        });

        test('Should warn at the end of a build without HTML', () => {
            getVite('build').closeBundle();
            expect(warn).toHaveBeenCalledTimes(1);
        });

        test('Should not warn in dev, nor when HTML was processed', () => {
            getVite('serve').closeBundle();
            const build = getVite('build');
            build.transformIndexHtml.handler(HTML);
            build.closeBundle();
            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('Rollup', () => {
        const run = (bundle: Record<string, any>) => {
            const { generateBundle }: any = setup().rollup;
            expect(generateBundle.order).toBe('post');
            generateBundle.handler({}, bundle);
        };

        test('Should rewrite the HTML assets only', () => {
            const bundle = {
                'index.html': { type: 'asset', fileName: 'index.html', source: HTML },
                'raw.html': {
                    type: 'asset',
                    fileName: 'raw.html',
                    source: new TextEncoder().encode(HTML),
                },
                'main.js': { type: 'chunk', fileName: 'main.js', code: HTML },
                'data.txt': { type: 'asset', fileName: 'data.txt', source: HTML },
            };
            run(bundle);
            expect(bundle['index.html'].source).toBe(INJECTED_HTML);
            expect(bundle['raw.html'].source).toBe(INJECTED_HTML);
            expect(bundle['data.txt'].source).toBe(HTML);
            expect(warn).not.toHaveBeenCalled();
        });

        test('Should warn without HTML', () => {
            run({ 'main.js': { type: 'chunk', fileName: 'main.js', code: '' } });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain(EARLY_COLLECTION_TAG);
        });
    });

    describe('webpack / rspack', () => {
        class RawSource {
            private content: string;
            constructor(content: string) {
                this.content = content;
            }
            source() {
                return this.content;
            }
        }
        const run = (assets: Record<string, string>) => {
            const stage = 1234;
            const bundler = {
                Compilation: { PROCESS_ASSETS_STAGE_SUMMARIZE: stage },
                sources: { RawSource },
            };
            const store = Object.fromEntries(
                Object.entries(assets).map(([name, content]) => [name, new RawSource(content)]),
            );
            let processAssets: { stage: number; cb: () => void } | undefined;
            const compilation = {
                hooks: {
                    processAssets: {
                        tap: ({ stage: s }: { stage: number }, cb: () => void) => {
                            processAssets = { stage: s, cb };
                        },
                    },
                },
                getAssets: () => Object.keys(store).map((name) => ({ name })),
                updateAsset: (name: string, fn: (old: any) => any) => {
                    store[name] = fn(store[name]);
                },
            };
            const compiler = {
                hooks: { thisCompilation: { tap: (_n: string, cb: any) => cb(compilation) } },
            };
            (setup(bundler).webpack as any)(compiler);
            expect(processAssets?.stage).toBe(stage);
            processAssets!.cb();
            return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.source()]));
        };

        test('Should rewrite the HTML assets only', () => {
            expect(run({ 'index.html': HTML, 'main.js': HTML })).toEqual({
                'index.html': INJECTED_HTML,
                'main.js': HTML,
            });
            expect(warn).not.toHaveBeenCalled();
        });

        test('Should warn without HTML', () => {
            run({ 'main.js': '' });
            expect(warn).toHaveBeenCalledTimes(1);
        });

        test('Should share the implementation between webpack and rspack', () => {
            const plugin = setup();
            expect(plugin.rspack).toBe(plugin.webpack);
        });
    });

    describe('esbuild', () => {
        let outdir: string;
        const run = async (initialOptions: Record<string, any>) => {
            let onEnd: (() => Promise<void>) | undefined;
            (setup().esbuild as any).setup({
                initialOptions,
                onEnd: (cb: () => Promise<void>) => {
                    onEnd = cb;
                },
            });
            await onEnd!();
        };

        beforeEach(() => {
            outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-collection-'));
        });
        afterEach(() => {
            fs.rmSync(outdir, { recursive: true, force: true });
        });

        test('Should rewrite the HTML files of the output directory', async () => {
            fs.mkdirSync(path.join(outdir, 'nested'));
            fs.writeFileSync(path.join(outdir, 'index.html'), HTML);
            fs.writeFileSync(path.join(outdir, 'nested', 'page.html'), HTML);
            fs.writeFileSync(path.join(outdir, 'main.js'), HTML);

            await run({ outdir });

            expect(fs.readFileSync(path.join(outdir, 'index.html'), 'utf-8')).toBe(INJECTED_HTML);
            expect(fs.readFileSync(path.join(outdir, 'nested', 'page.html'), 'utf-8')).toBe(
                INJECTED_HTML,
            );
            expect(fs.readFileSync(path.join(outdir, 'main.js'), 'utf-8')).toBe(HTML);
            expect(warn).not.toHaveBeenCalled();
        });

        test('Should use the outfile directory', async () => {
            fs.writeFileSync(path.join(outdir, 'index.html'), HTML);
            await run({ outfile: path.join(outdir, 'bundle.js') });
            expect(fs.readFileSync(path.join(outdir, 'index.html'), 'utf-8')).toBe(INJECTED_HTML);
        });

        test('Should warn without HTML', async () => {
            await run({ outdir });
            expect(warn).toHaveBeenCalledTimes(1);
        });
    });
});
