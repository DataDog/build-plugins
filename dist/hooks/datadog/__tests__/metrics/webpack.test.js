"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const webpack_1 = require("../../metrics/webpack");
const helpers_1 = require("../../../../helpers");
const exec = require('util').promisify(require('child_process').exec);
const PROJECTS_ROOT = path_1.default.join(__dirname, '../../../../__tests__/mocks/projects');
describe('Metrics', () => {
    beforeAll(() => __awaiter(void 0, void 0, void 0, function* () {
        yield exec(`yarn build`);
    }), 20000);
    for (const version of [4, 5]) {
        describe(`Webpack ${version}`, () => {
            let statsJson;
            const WEBPACK_ROOT = path_1.default.join(PROJECTS_ROOT, `./webpack${version}`);
            const OUTPUT = path_1.default.join(WEBPACK_ROOT, `./webpack-profile-debug/`);
            beforeAll(() => __awaiter(void 0, void 0, void 0, function* () {
                const output = yield exec(`yarn workspace webpack${version} build`);
                // eslint-disable-next-line no-console
                console.log(`Build ${version} :`, output.stderr);
                statsJson = require(path_1.default.join(OUTPUT, './bundler.json'));
            }), 20000);
            describe('Modules', () => {
                let metrics;
                beforeAll(() => {
                    const indexed = webpack_1.getIndexed(statsJson, WEBPACK_ROOT);
                    metrics = webpack_1.getModules(statsJson, indexed, WEBPACK_ROOT);
                });
                test('It should give module metrics.', () => {
                    expect(metrics.length).not.toBe(0);
                });
                test(`It should filter out webpack's modules.`, () => {
                    expect(metrics.find((m) => {
                        return m.tags.find((t) => /^moduleName:webpack\/runtime/.test(t));
                    })).toBeUndefined();
                });
                test(`It should add tags about the entry and the chunk.`, () => {
                    for (const metric of metrics) {
                        expect(metric.tags).toContain('entryName:yolo');
                        expect(metric.tags).toContain('entryName:cheesecake');
                        expect(metric.tags).toContain('chunkName:yolo');
                        expect(metric.tags).toContain('chunkName:cheesecake');
                    }
                });
                test('It should have 1 metric per module.', () => {
                    const modules = [
                        './src/file0000.js',
                        './src/file0001.js',
                        './workspaces/app/file0000.js',
                        './workspaces/app/file0001.js',
                    ];
                    for (const module of modules) {
                        const modulesMetrics = metrics.filter((m) => m.tags.includes(`moduleName:${helpers_1.getDisplayName(module)}`));
                        expect(modulesMetrics.length).toBe(1);
                    }
                });
            });
            describe('Entries', () => {
                let metrics;
                beforeAll(() => {
                    const indexed = webpack_1.getIndexed(statsJson, WEBPACK_ROOT);
                    metrics = webpack_1.getEntries(statsJson, indexed);
                });
                test('It should give entries metrics.', () => {
                    expect(metrics.length).not.toBe(0);
                });
                test('It should give 4 metrics per entry.', () => {
                    const entries = ['yolo', 'cheesecake'];
                    for (const entry of entries) {
                        const entriesMetrics = metrics.filter((m) => m.tags.includes(`entryName:${entry}`));
                        expect(entriesMetrics.length).toBe(4);
                    }
                });
            });
            describe('Chunks', () => {
                let metrics;
                beforeAll(() => {
                    const indexed = webpack_1.getIndexed(statsJson, WEBPACK_ROOT);
                    metrics = webpack_1.getChunks(statsJson, indexed);
                });
                test('It should give chunks metrics.', () => {
                    expect(metrics.length).not.toBe(0);
                });
                test('It should give 2 metrics per chunk.', () => {
                    const chunks = ['yolo', 'cheesecake'];
                    for (const chunk of chunks) {
                        const chunksMetrics = metrics.filter((m) => m.tags.includes(`chunkName:${chunk}`));
                        expect(chunksMetrics.length).toBe(2);
                    }
                });
                test(`It should add tags about the entry.`, () => {
                    for (const metric of metrics) {
                        expect(metric.tags.join(',')).toMatch(/entryName:(yolo|cheesecake)/);
                    }
                });
            });
            describe('Assets', () => {
                let metrics;
                beforeAll(() => {
                    const indexed = webpack_1.getIndexed(statsJson, WEBPACK_ROOT);
                    metrics = webpack_1.getAssets(statsJson, indexed);
                });
                test('It should give assets metrics.', () => {
                    expect(metrics.length).not.toBe(0);
                });
                test('It should give 1 metric per asset.', () => {
                    const assets = ['yolo.js', 'cheesecake.js'];
                    for (const asset of assets) {
                        const assetsMetrics = metrics.filter((m) => m.tags.includes(`assetName:${asset}`));
                        expect(assetsMetrics.length).toBe(1);
                    }
                });
                test(`It should add tags about the entry and the chunk.`, () => {
                    for (const metric of metrics) {
                        expect(metric.tags).toContain('entryName:yolo');
                        expect(metric.tags).toContain('entryName:cheesecake');
                        expect(metric.tags).toContain('chunkName:yolo');
                        expect(metric.tags).toContain('chunkName:cheesecake');
                    }
                });
            });
        });
    }
});
