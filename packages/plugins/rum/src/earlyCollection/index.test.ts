// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { EARLY_COLLECTION_TAG, EARLY_COLLECTION_URL } from '@dd/rum-plugin/earlyCollection/html';
import { getEarlyCollectionPlugin } from '@dd/rum-plugin/earlyCollection/index';
import { getContextMock, getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HTML = '<html><head><title>a</title></head><body></body></html>';
const INJECTED_HTML = `<html><head>${EARLY_COLLECTION_TAG}<title>a</title></head><body></body></html>`;

describe('Early collection plugin', () => {
    const warn = jest.fn();
    const setup = (bundler: any = {}, buildRoot = '/cwd/path', bundlerName = 'webpack') => {
        const log = { ...getMockLogger(), warn };
        return getEarlyCollectionPlugin(
            bundler,
            getContextMock({
                getLogger: () => log,
                buildRoot,
                bundler: { name: bundlerName } as any,
            }),
        );
    };

    beforeEach(() => {
        warn.mockClear();
    });

    describe('Vite', () => {
        const getVite = (config: Record<string, any> = {}, command = 'build') => {
            const vite: any = setup().vite;
            vite.configResolved({ command, build: config });
            return vite;
        };

        test('Should add the tag before the other plugins', () => {
            const { transformIndexHtml } = getVite();
            expect(transformIndexHtml.order).toBe('pre');
            expect(transformIndexHtml.handler(HTML)).toEqual([
                { tag: 'script', attrs: { src: EARLY_COLLECTION_URL }, injectTo: 'head-prepend' },
            ]);
        });

        test('Should not add the tag twice', () => {
            expect(getVite().transformIndexHtml.handler(INJECTED_HTML)).toEqual([]);
        });

        test('Should warn once at the end of a build without HTML', () => {
            const vite = getVite();
            vite.closeBundle();
            vite.closeBundle();
            expect(warn).toHaveBeenCalledTimes(1);
        });

        test('Should not warn in dev, for library and SSR builds, nor when HTML was processed', () => {
            getVite({}, 'serve').closeBundle();
            getVite({ lib: {} }).closeBundle();
            getVite({ ssr: true }).closeBundle();
            const build = getVite();
            build.transformIndexHtml.handler(HTML);
            build.closeBundle();
            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('Rollup', () => {
        const run = (bundle: Record<string, any>, plugin = setup()) => {
            const { generateBundle }: any = plugin.rollup;
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

        test('Should not warn for an output without HTML once another one had some', () => {
            const plugin = setup();
            run({ 'index.html': { type: 'asset', fileName: 'index.html', source: HTML } }, plugin);
            run({ 'main.js': { type: 'chunk', fileName: 'main.js', code: '' } }, plugin);
            expect(warn).not.toHaveBeenCalled();
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
        const run = (assets: Record<string, string | Buffer>, plugin = setup()) => {
            const stage = 1234;
            const bundler = {
                Compilation: { PROCESS_ASSETS_STAGE_SUMMARIZE: stage },
                sources: { RawSource },
            };
            const store: Record<string, { source: () => string | Buffer }> = Object.fromEntries(
                Object.entries(assets).map(([name, content]) => [name, { source: () => content }]),
            );
            const updateAsset = jest.fn((name: string, source: RawSource) => {
                store[name] = source;
            });
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
                getAsset: (name: string) => ({ name, source: store[name] }),
                updateAsset,
            };
            const compiler = {
                hooks: { thisCompilation: { tap: (_n: string, cb: any) => cb(compilation) } },
            };
            (setup(bundler).webpack as any)(compiler);
            expect(processAssets?.stage).toBe(stage);
            processAssets!.cb();
            return {
                updateAsset,
                result: Object.fromEntries(
                    Object.entries(store).map(([k, v]) => [k, v.source().toString()]),
                ),
            };
        };

        test('Should rewrite the HTML assets only', () => {
            const { result, updateAsset } = run({
                'index.html': HTML,
                'buffer.html': Buffer.from(HTML),
                'main.js': HTML,
            });
            expect(result).toEqual({
                'index.html': INJECTED_HTML,
                'buffer.html': INJECTED_HTML,
                'main.js': HTML,
            });
            expect(updateAsset).toHaveBeenCalledTimes(2);
            expect(warn).not.toHaveBeenCalled();
        });

        test('Should not update the assets that already have the tag', () => {
            const { updateAsset } = run({ 'index.html': INJECTED_HTML });
            expect(updateAsset).not.toHaveBeenCalled();
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
        let root: string;
        let outdir: string;
        const run = async (
            initialOptions: Record<string, any>,
            result: Record<string, any> = { errors: [] },
        ) => {
            let onEnd: ((result: any) => Promise<void>) | undefined;
            (setup({}, root, 'esbuild').esbuild as any).setup({
                initialOptions,
                onEnd: (cb: (result: any) => Promise<void>) => {
                    onEnd = cb;
                },
            });
            await onEnd!(result);
        };
        const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), 'utf-8');

        beforeEach(() => {
            root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'early-collection-')));
            outdir = path.join(root, 'dist');
            fs.mkdirSync(outdir);
        });
        afterEach(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });

        test('Should rewrite the HTML files of the output directory', async () => {
            fs.mkdirSync(path.join(outdir, 'nested'));
            fs.writeFileSync(path.join(outdir, 'index.html'), HTML);
            fs.writeFileSync(path.join(outdir, 'nested', 'page.html'), HTML);
            fs.writeFileSync(path.join(outdir, 'main.js'), HTML);

            await run({ outdir });

            expect(read(outdir, 'index.html')).toBe(INJECTED_HTML);
            expect(read(outdir, 'nested', 'page.html')).toBe(INJECTED_HTML);
            expect(read(outdir, 'main.js')).toBe(HTML);
            expect(warn).not.toHaveBeenCalled();
        });

        test('Should resolve a relative outdir from the build root', async () => {
            fs.writeFileSync(path.join(outdir, 'index.html'), HTML);
            await run({ outdir: 'dist' });
            expect(read(outdir, 'index.html')).toBe(INJECTED_HTML);
        });

        test('Should use the outfile directory', async () => {
            fs.writeFileSync(path.join(outdir, 'index.html'), HTML);
            await run({ outfile: path.join(outdir, 'bundle.js') });
            expect(read(outdir, 'index.html')).toBe(INJECTED_HTML);
        });

        test('Should skip hidden directories, node_modules and symlinks', async () => {
            fs.mkdirSync(path.join(outdir, '.cache'));
            fs.mkdirSync(path.join(outdir, 'node_modules'));
            fs.writeFileSync(path.join(outdir, '.cache', 'a.html'), HTML);
            fs.writeFileSync(path.join(outdir, 'node_modules', 'b.html'), HTML);
            fs.writeFileSync(path.join(root, 'source.html'), HTML);
            fs.symlinkSync(path.join(root, 'source.html'), path.join(outdir, 'link.html'));
            fs.writeFileSync(path.join(outdir, 'index.html'), HTML);

            await run({ outdir });

            expect(read(outdir, '.cache', 'a.html')).toBe(HTML);
            expect(read(outdir, 'node_modules', 'b.html')).toBe(HTML);
            expect(read(root, 'source.html')).toBe(HTML);
            expect(read(outdir, 'index.html')).toBe(INJECTED_HTML);
        });

        test('Should never rewrite the sources when the output is the project root', async () => {
            fs.writeFileSync(path.join(root, 'template.html'), HTML);
            await run({ outdir: root });
            await run({ outfile: path.join(root, 'out.js') });
            await run({ outdir: path.dirname(root) });
            expect(read(root, 'template.html')).toBe(HTML);
            expect(warn).toHaveBeenCalledTimes(3);
            expect(warn.mock.calls[0][0]).toContain('project root');
        });

        test('Should do nothing when the build failed', async () => {
            fs.writeFileSync(path.join(outdir, 'index.html'), HTML);
            await run({ outdir }, { errors: [{}] });
            expect(read(outdir, 'index.html')).toBe(HTML);
            expect(warn).not.toHaveBeenCalled();
        });

        test('Should warn when nothing is written to disk or there is no output directory', async () => {
            await run({ outdir, write: false });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('write: false');
            warn.mockClear();
            await run({});
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('could not be determined');
        });

        test('Should warn without HTML, and mention the plugin order', async () => {
            await run({ outdir });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('after the plugin');
        });
    });
});
