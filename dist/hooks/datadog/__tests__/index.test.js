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
Object.defineProperty(exports, "__esModule", { value: true });
const testHelpers_1 = require("../../../__tests__/helpers/testHelpers");
describe('Datadog Hook', () => {
    const buildPluginMock = {
        log: (...args) => {
            // eslint-disable-next-line no-console
            console.log(...args);
        },
        options: {},
    };
    test('It should not fail given undefined options', () => __awaiter(void 0, void 0, void 0, function* () {
        const { hooks } = require('../index');
        const obj = yield hooks.preoutput.call(buildPluginMock, {
            report: testHelpers_1.mockReport,
            bundler: testHelpers_1.mockBundler,
        });
        expect(typeof obj).toBe('object');
    }));
    test('It should export hooks', () => {
        const datadog = require('../index');
        expect(typeof datadog.hooks).toBe('object');
    });
});
