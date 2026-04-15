// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    discoverBackendFunctions,
    discoverExportedFunctions,
} from '@dd/apps-plugin/backend/discovery';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs';
import { globSync } from 'glob';

jest.mock('glob');

const log = getMockLogger();
const projectRoot = '/project';

const mockedGlobSync = jest.mocked(globSync);

describe('Backend Functions - discoverExportedFunctions', () => {
    let readFileSpy: jest.SpyInstance;

    beforeEach(() => {
        readFileSpy = jest.spyOn(fs, 'readFileSync');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('Should discover named exports', () => {
        readFileSpy.mockReturnValue(
            'export function add(a: number, b: number): number { return a + b; }\nexport function multiply(a: number, b: number): number { return a * b; }',
        );

        const result = discoverExportedFunctions('/project/src/math.backend.ts');
        expect(result).toEqual(['add', 'multiply']);
        expect(readFileSpy).toHaveBeenCalledWith('/project/src/math.backend.ts', 'utf-8');
    });

    test('Should filter out type exports', () => {
        readFileSpy.mockReturnValue(
            'export function add(a: number, b: number): number { return a + b; }\nexport type MathResult = { value: number };',
        );

        const result = discoverExportedFunctions('/project/src/math.backend.ts');
        expect(result).toEqual(['add']);
    });

    test('Should filter out export interface', () => {
        readFileSpy.mockReturnValue(
            'export function greet(name: string): string { return name; }\nexport interface Config { timeout: number; }',
        );

        const result = discoverExportedFunctions('/project/src/greet.backend.ts');
        expect(result).toEqual(['greet']);
    });

    test('Should filter out inline type specifiers in export blocks', () => {
        readFileSpy.mockReturnValue(
            'function add(a: number, b: number): number { return a + b; }\ntype Foo = string;\nexport { type Foo, add };',
        );

        const result = discoverExportedFunctions('/project/src/math.backend.ts');
        expect(result).toEqual(['add']);
    });

    test('Should discover exported const arrow functions', () => {
        readFileSpy.mockReturnValue('export const add = (a: number, b: number): number => a + b;');

        const result = discoverExportedFunctions('/project/src/math.backend.ts');
        expect(result).toEqual(['add']);
    });

    test('Should throw on default exports', () => {
        readFileSpy.mockReturnValue('export default function handler() { return 1; }');

        expect(() => discoverExportedFunctions('/project/src/math.backend.ts')).toThrow(
            'Default exports are not supported in .backend.ts files',
        );
    });

    test('Should return empty array for files with no exports', () => {
        readFileSpy.mockReturnValue('function internal() { return 1; }');

        const result = discoverExportedFunctions('/project/src/empty.backend.ts');
        expect(result).toEqual([]);
    });
});

describe('Backend Functions - discoverBackendFunctions', () => {
    let readFileSpy: jest.SpyInstance;

    beforeEach(() => {
        readFileSpy = jest.spyOn(fs, 'readFileSync');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('Should discover .backend.ts files via glob and parse their exports', () => {
        mockedGlobSync.mockReturnValue([
            '/project/src/utils/mathUtils.backend.ts',
            '/project/src/auth/login.backend.ts',
        ] as any);
        readFileSpy
            .mockReturnValueOnce(
                'export function add() { return 1; }\nexport function multiply() { return 2; }',
            )
            .mockReturnValueOnce('export function login() { return true; }');

        const result = discoverBackendFunctions(projectRoot, log);

        expect(result).toEqual([
            {
                ref: { path: 'src/utils/mathUtils', name: 'add' },
                entryPath: '/project/src/utils/mathUtils.backend.ts',
            },
            {
                ref: { path: 'src/utils/mathUtils', name: 'multiply' },
                entryPath: '/project/src/utils/mathUtils.backend.ts',
            },
            {
                ref: { path: 'src/auth/login', name: 'login' },
                entryPath: '/project/src/auth/login.backend.ts',
            },
        ]);
    });

    test('Should return empty array when no .backend.ts files exist', () => {
        mockedGlobSync.mockReturnValue([]);

        const result = discoverBackendFunctions(projectRoot, log);
        expect(result).toEqual([]);
    });

    test('Should skip files with no exports', () => {
        mockedGlobSync.mockReturnValue(['/project/src/empty.backend.ts'] as any);
        readFileSpy.mockReturnValue('function internal() {}');

        const result = discoverBackendFunctions(projectRoot, log);
        expect(result).toEqual([]);
    });

    test('Should continue when a file fails to parse', () => {
        mockedGlobSync.mockReturnValue([
            '/project/src/bad.backend.ts',
            '/project/src/good.backend.ts',
        ] as any);
        readFileSpy
            .mockReturnValueOnce('this is not valid {{ javascript')
            .mockReturnValueOnce('export function greet() { return "hi"; }');

        const result = discoverBackendFunctions(projectRoot, log);
        expect(result).toEqual([
            {
                ref: { path: 'src/good', name: 'greet' },
                entryPath: '/project/src/good.backend.ts',
            },
        ]);
    });

    test('Should strip .backend.{ext} to form the ref path', () => {
        mockedGlobSync.mockReturnValue(['/project/mathUtils.backend.tsx'] as any);
        readFileSpy.mockReturnValue('export function calc() { return 1; }');

        const result = discoverBackendFunctions(projectRoot, log);
        expect(result[0].ref.path).toBe('mathUtils');
    });

    test('Should call globSync with correct pattern and options', () => {
        mockedGlobSync.mockReturnValue([]);

        discoverBackendFunctions(projectRoot, log);

        expect(mockedGlobSync).toHaveBeenCalledWith('**/*.backend.{ts,tsx,js,jsx}', {
            cwd: projectRoot,
            ignore: ['**/node_modules/**', '**/dist/**', '**/.dist/**'],
            absolute: true,
        });
    });
});
