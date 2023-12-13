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
const esbuild_1 = require("../../metrics/esbuild");
const helpers_1 = require("../../../../helpers");
const exec = require('util').promisify(require('child_process').exec);
const PROJECTS_ROOT = path_1.default.join(__dirname, '../../../../__tests__/mocks/projects');
describe('Metrics', () => {
    beforeAll(() => __awaiter(void 0, void 0, void 0, function* () {
        yield exec(`yarn build`);
    }), 20000);
    describe(`Esbuild`, () => {
        let statsJson;
        const ESBUILD_ROOT = path_1.default.join(PROJECTS_ROOT, `./esbuild`);
        const OUTPUT = path_1.default.join(ESBUILD_ROOT, `./esbuild-profile-debug/`);
        beforeAll(() => __awaiter(void 0, void 0, void 0, function* () {
            const output = yield exec(`yarn workspace esbuild build`);
            // eslint-disable-next-line no-console
            console.log(`Build :`, output.stderr);
            statsJson = require(path_1.default.join(OUTPUT, './bundler.json'));
        }), 20000);
        describe('Modules', () => {
            let metrics;
            beforeAll(() => {
                const indexed = esbuild_1.getIndexed(statsJson, ESBUILD_ROOT);
                metrics = esbuild_1.getModules(statsJson, indexed, ESBUILD_ROOT);
            });
            test('It should give module metrics.', () => {
                expect(metrics.length).not.toBe(0);
            });
            test(`It should add tags about the entry and the chunk.`, () => {
                for (const metric of metrics) {
                    expect(metric.tags).toContain('entryName:yolo');
                    expect(metric.tags).toContain('entryName:cheesecake');
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
                const indexed = esbuild_1.getIndexed(statsJson, ESBUILD_ROOT);
                metrics = esbuild_1.getEntries(statsJson, indexed, ESBUILD_ROOT);
            });
            test('It should give entries metrics.', () => {
                expect(metrics.length).not.toBe(0);
            });
            test('It should give 3 metrics per entry.', () => {
                const entries = ['yolo', 'cheesecake'];
                for (const entry of entries) {
                    const entriesMetrics = metrics.filter((m) => m.tags.includes(`entryName:${entry}`));
                    expect(entriesMetrics.length).toBe(3);
                }
            });
        });
        describe('Assets', () => {
            let metrics;
            beforeAll(() => {
                const indexed = esbuild_1.getIndexed(statsJson, ESBUILD_ROOT);
                metrics = esbuild_1.getAssets(statsJson, indexed, ESBUILD_ROOT);
            });
            test('It should give assets metrics.', () => {
                expect(metrics.length).not.toBe(0);
            });
            test('It should give 1 metric per asset.', () => {
                const assets = ['yolo\\.js', 'cheesecake\\.js'];
                for (const asset of assets) {
                    const rx = new RegExp(`^assetName:.*${asset}$`);
                    const assetsMetrics = metrics.filter((m) => m.tags.some((tag) => rx.test(tag)));
                    expect(assetsMetrics.length).toBe(1);
                }
            });
            test(`It should add tags about the entry.`, () => {
                for (const metric of metrics) {
                    expect(metric.tags).toContain('entryName:yolo');
                    expect(metric.tags).toContain('entryName:cheesecake');
                }
            });
        });
    });
});
