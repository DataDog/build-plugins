// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { bold, dim, dimRed, green, red, slugify } from '@dd/tools/helpers';
import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';
import select from '@inquirer/select';

import { bundlerHookNames, typesOfPlugin, universalHookNames } from './constants';
import { bundlerHooks, universalHooks } from './hooks';
import type { AnyHook, EitherHookList, EitherHookTable, Hook, TypeOfPlugin } from './types';

export const getName = async (nameInput?: string) => {
    if (nameInput) {
        return slugify(nameInput);
    }

    const name = await input({
        message: `Enter the name of your plugin (${dim('will auto format the name')}):`,
        transformer: (n: string) => green(slugify(n)),
    });

    return slugify(name);
};

export const getDescription = async (descriptionInput?: string) => {
    if (descriptionInput) {
        return descriptionInput;
    }

    return input({
        message: 'Enter a description for your plugin:',
        transformer: (description: string) => green(description),
    });
};

const sanitizeCodeowners = (codeowners: string) => {
    return (
        codeowners
            // Remove potential commas and spaces
            .replace(/ *, */, ' ')
            .split(' ')
            // Add missing @s
            .map((codeowner) => codeowner.replace(/^[^@]/, '@$&'))
            .join(' ')
    );
};

export const getCodeowners = async (codeownersInput?: string[]) => {
    if (codeownersInput) {
        return sanitizeCodeowners(codeownersInput.join(','));
    }

    const codeowners = await input({
        message: `Enter the codeowner(s) for your plugin (${dim('will auto-add @ and format the list')}):`,
        transformer: (co: string) => green(sanitizeCodeowners(co)),
    });
    return sanitizeCodeowners(codeowners);
};

const listHooks = (list: EitherHookList) => {
    return (Object.entries(list) as [AnyHook, Hook][]).map(([value, hook]) => ({
        name: `${bold(hook.name)}\n    ${dim(hook.descriptions.join('\n    '))}`,
        value,
        checked: false,
    }));
};

export const getTypeOfPlugin = async (typeInput?: TypeOfPlugin) => {
    if (typeInput) {
        if (!typesOfPlugin.includes(typeInput)) {
            throw new Error(`Invalid plugin type: ${red(typeInput)}`);
        }

        return typeInput;
    }

    return select<TypeOfPlugin>({
        message: 'What type of plugin do you want to create?',
        choices: [
            { name: `[${green('Recommended')}] Universal Plugin`, value: 'universal' },
            { name: `[${dim('Discouraged')}] Bundler Specific Plugin`, value: 'bundler' },
        ],
    });
};

export const validateHooks = (
    pluginType: TypeOfPlugin,
    hooksToValidate: AnyHook[],
): EitherHookTable => {
    const validHooks: AnyHook[] = [];
    const invalidHooks: AnyHook[] = [];

    const refHooks = pluginType === 'universal' ? universalHookNames : bundlerHookNames;
    for (const hook of hooksToValidate) {
        // Need casting because of contravarience.
        // refHooks is BundlerHook[] | UniversalHook[], so .includes(AnyHook) is impossible.
        if ((refHooks as Readonly<AnyHook[]>).includes(hook)) {
            validHooks.push(hook);
        } else {
            invalidHooks.push(hook);
        }
    }

    if (invalidHooks.length) {
        console.log(
            `\nRemoved invalid hooks for "${pluginType}" plugin: ${dimRed(invalidHooks.join(', '))}`,
        );
    }

    // Casting because the validation was done above.
    return validHooks as EitherHookTable;
};

export const getHooksToInclude = async (
    pluginType: TypeOfPlugin,
    hooksInput?: AnyHook[],
): Promise<EitherHookTable> => {
    if (hooksInput && hooksInput.length) {
        return validateHooks(pluginType, hooksInput);
    }

    // List all hooks available in the universal plugin framework.
    const hooksContent = listHooks(universalHooks);
    const bundlersContent = listHooks(bundlerHooks);
    const choices = pluginType === 'universal' ? hooksContent : bundlersContent;
    return checkbox<AnyHook>({
        message: `Which ${pluginType === 'universal' ? 'hooks' : 'bundlers'} do you want to support?`,
        pageSize: 25,
        choices,
    }) as Promise<EitherHookTable>;
};
