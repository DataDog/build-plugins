// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getCodeowners,
    getDescription,
    getHooksToInclude,
    getName,
    getTypeOfPlugin,
    listChoices,
    sanitizeCodeowners,
    validateHooks,
} from '@dd/tools/commands/create-plugin/ask';
import {
    bundlerHookNames,
    typesOfPlugin,
    universalHookNames,
} from '@dd/tools/commands/create-plugin/constants';
import {
    allHooks,
    bundlerHooks,
    pluginTypes,
    universalHooks,
} from '@dd/tools/commands/create-plugin/hooks';
import type { AnyHook, TypeOfPlugin } from '@dd/tools/commands/create-plugin/types';
import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';
import select from '@inquirer/select';

jest.mock('@inquirer/checkbox', () => jest.fn());
jest.mock('@inquirer/input', () => jest.fn());
jest.mock('@inquirer/select', () => jest.fn());

const checkboxMocked = jest.mocked(checkbox);
const inputMocked = jest.mocked(input);
const selectMocked = jest.mocked(select);

describe('ask.ts', () => {
    describe('getName', () => {
        test.each([
            ['Testing #1', 'testing-1'],
            ['Some, Name. With punctuation.', 'some-name-with-punctuation'],
            ['Âñy Wëîrd Nâmë', 'any-weird-name'],
        ])('Should slugify "%s" into "%s".', async (nameInput, expectation) => {
            const name = await getName(nameInput);
            expect(name).toBe(expectation);
        });

        test('Should ask for a name if none is provided.', async () => {
            inputMocked.mockResolvedValueOnce('Testing #1');
            const name = await getName();
            expect(name).toBe('testing-1');
            expect(inputMocked).toHaveBeenCalledTimes(1);
        });

        test('Should throw an error if noAsk is true and no name is provided.', async () => {
            await expect(getName(undefined, true)).rejects.toThrow(
                '--name is required when using --no-ask',
            );
            expect(inputMocked).not.toHaveBeenCalled();
        });

        test('Should return the name if noAsk is true and name is provided.', async () => {
            const name = await getName('My Test', true);
            expect(name).toBe('my-test');
            expect(inputMocked).not.toHaveBeenCalled();
        });
    });

    describe('getDescription', () => {
        test('Should return the description if provided.', async () => {
            const description = await getDescription('Some description.');
            expect(description).toBe('Some description.');
        });

        test('Should ask for a description if none is provided.', async () => {
            inputMocked.mockResolvedValueOnce('Some description.');
            const description = await getDescription();
            expect(description).toBe('Some description.');
            expect(inputMocked).toHaveBeenCalledTimes(1);
        });

        test('Should return empty string if noAsk is true and no description is provided.', async () => {
            const description = await getDescription(undefined, true);
            expect(description).toBe('');
            expect(inputMocked).not.toHaveBeenCalled();
        });

        test('Should return the description if noAsk is true and description is provided.', async () => {
            const description = await getDescription('Some description.', true);
            expect(description).toBe('Some description.');
            expect(inputMocked).not.toHaveBeenCalled();
        });
    });

    describe('sanitizeCodeowners', () => {
        test.each([
            ['@codeowners-1 @codeowners-2', '@codeowners-1 @codeowners-2'],
            ['codeowners-1 codeowners-2', '@codeowners-1 @codeowners-2'],
            ['@codeowners-1  ,   codeowners-2', '@codeowners-1 @codeowners-2'],
            ['@codeowners-1,codeowners-2', '@codeowners-1 @codeowners-2'],
        ])('Should sanitize "%s" into "%s".', (stringInput, expectation) => {
            const codeowners = sanitizeCodeowners(stringInput);
            expect(codeowners).toBe(expectation);
        });
    });

    describe('getCodeowners', () => {
        test('Should return the codeowners if provided.', async () => {
            const codeowners = await getCodeowners(['@codeowners-1', '@codeowners-2']);
            expect(codeowners).toBe('@codeowners-1 @codeowners-2');
        });

        test('Should ask for codeowners if none are provided.', async () => {
            inputMocked.mockResolvedValueOnce('@codeowners-1 @codeowners-2');
            const codeowners = await getCodeowners();
            expect(codeowners).toBe('@codeowners-1 @codeowners-2');
            expect(inputMocked).toHaveBeenCalledTimes(1);
        });

        test('Should sanitize the codeowners.', async () => {
            const codeowners = await getCodeowners(['codeowners-1', 'codeowners-2']);
            expect(codeowners).toBe('@codeowners-1 @codeowners-2');
        });

        test('Should throw an error if noAsk is true and no codeowners are provided.', async () => {
            await expect(getCodeowners(undefined, true)).rejects.toThrow(
                '--codeowner is required when using --no-ask',
            );
            expect(inputMocked).not.toHaveBeenCalled();
        });

        test('Should return the codeowners if noAsk is true and codeowners are provided.', async () => {
            const codeowner = await getCodeowners(['@owner'], true);
            expect(codeowner).toBe('@owner');
            expect(inputMocked).not.toHaveBeenCalled();
        });
    });

    describe('listChoices', () => {
        test.each([
            ['bundler', bundlerHooks, bundlerHookNames],
            ['universal', universalHooks, universalHookNames],
            ['internal', pluginTypes, typesOfPlugin],
        ])(
            'Should return the choices for "%s" in a formated list.',
            (type, listInput, expectedValue) => {
                const choicesReturned = listChoices(listInput);
                expect(
                    choicesReturned.sort((a, b) => (a.value as string).localeCompare(b.value)),
                ).toEqual(
                    [...expectedValue].sort().map((value) => ({
                        name: expect.any(String),
                        value,
                    })),
                );
            },
        );
    });

    describe('getTypeOfPlugin', () => {
        test('Should return the type if provided.', async () => {
            const type = await getTypeOfPlugin('universal');
            expect(type).toBe('universal');
        });

        test('Should ask for a type if an invalid one is provided.', async () => {
            selectMocked.mockResolvedValueOnce('universal');
            // @ts-expect-error We are testing the error case.
            const type = await getTypeOfPlugin('invalid');
            expect(type).toBe('universal');
            expect(selectMocked).toHaveBeenCalledTimes(1);
        });

        test('Should ask for a type if none is provided.', async () => {
            selectMocked.mockResolvedValueOnce('universal');
            const type = await getTypeOfPlugin();
            expect(type).toBe('universal');
            expect(selectMocked).toHaveBeenCalledTimes(1);
        });

        test('Should return "universal" if noAsk is true and no type is provided.', async () => {
            const type = await getTypeOfPlugin(undefined, true);
            expect(type).toBe('universal');
            expect(selectMocked).not.toHaveBeenCalled();
        });

        test('Should return the type if noAsk is true and type is provided.', async () => {
            const type = await getTypeOfPlugin('bundler', true);
            expect(type).toBe('bundler');
            expect(selectMocked).not.toHaveBeenCalled();
        });
    });

    describe('validateHooks', () => {
        test.each<[TypeOfPlugin, AnyHook[], string[]]>([
            ['universal', ['enforce', 'buildStart'], ['enforce', 'buildStart']],
            ['universal', ['enforce', 'buildStart', 'webpack'], ['enforce', 'buildStart']],
            ['bundler', ['webpack', 'esbuild'], ['webpack', 'esbuild']],
            ['bundler', ['enforce', 'buildStart', 'webpack'], ['webpack']],
            ['bundler', ['enforce', 'buildStart'], []],
            ['internal', ['buildStart', 'webpack'], ['buildStart', 'webpack']],
            // @ts-expect-error We are testing the non-existing hook case.
            ['internal', ['buildStart', 'webpack', 'nonExistingHook'], ['buildStart', 'webpack']],
        ])(
            'Should return the the expected set of hooks for "%s" plugin.',
            (pluginType, hooksInput, expectation) => {
                const hooksReturned = validateHooks(pluginType, hooksInput);
                expect(hooksReturned).toEqual(expectation);
            },
        );
    });

    describe('getHooksToInclude', () => {
        test('Should return the hooks if provided.', async () => {
            const hooksReturned = await getHooksToInclude('universal', ['enforce', 'buildStart']);
            expect(hooksReturned).toEqual(['enforce', 'buildStart']);
        });

        test('Should filter out invalid hooks when provided.', async () => {
            const hooksReturned = await getHooksToInclude('bundler', [
                'enforce',
                'buildStart',
                'webpack',
            ]);
            expect(hooksReturned).toEqual(['webpack']);
        });

        test('Should ask for hooks if none are provided.', async () => {
            checkboxMocked.mockResolvedValueOnce(['enforce', 'buildStart']);
            const hooksReturned = await getHooksToInclude('universal');
            expect(hooksReturned).toEqual(['enforce', 'buildStart']);
            expect(checkboxMocked).toHaveBeenCalledTimes(1);
        });

        test.each<[TypeOfPlugin, any[]]>([
            ['universal', listChoices(universalHooks)],
            ['bundler', listChoices(bundlerHooks)],
            ['internal', listChoices(allHooks)],
        ])(
            'Should offer a specific list of hooks for "%s" plugins.',
            async (pluginType, expectedChoices) => {
                await getHooksToInclude(pluginType);
                expect(checkboxMocked).toHaveBeenCalledWith(
                    expect.objectContaining({
                        choices: expectedChoices.map((choice) => ({ ...choice, checked: false })),
                    }),
                );
            },
        );

        test('Should return empty array if noAsk is true and no hooks are provided.', async () => {
            const hooksReturned = await getHooksToInclude('universal', undefined, true);
            expect(hooksReturned).toEqual([]);
            expect(checkboxMocked).not.toHaveBeenCalled();
        });

        test('Should return the hooks if noAsk is true and hooks are provided.', async () => {
            const hooksReturned = await getHooksToInclude(
                'universal',
                ['enforce', 'buildStart'],
                true,
            );
            expect(hooksReturned).toEqual(['enforce', 'buildStart']);
            expect(checkboxMocked).not.toHaveBeenCalled();
        });
    });
});
