// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { cleanPluginName } from '@dd/core/helpers/plugins';
import { bold, dim, dimRed, green, red, slugify } from '@dd/tools/helpers';
import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';
import select from '@inquirer/select';

import { allHookNames, bundlerHookNames, typesOfPlugin, universalHookNames } from './constants';
import { allHooks, bundlerHooks, pluginTypes, universalHooks } from './hooks';
import type { AnyHook, Choice, TypeOfPlugin } from './types';

export const getName = async (nameInput?: string) => {
    const processName = (name: string) => {
        return cleanPluginName(slugify(name));
    };
    if (nameInput) {
        return processName(nameInput);
    }

    const nameAnswer = await input({
        message: `Enter the name of your plugin (${dim('will auto format the name')}):`,
        transformer: (n: string) => green(processName(n)),
    });

    return processName(nameAnswer);
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

export const sanitizeCodeowners = (codeowners: string) => {
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

export const listChoices = <T extends Record<string, Choice>>(list: T) => {
    return (Object.entries(list) as [keyof T, Choice][]).map(([value, choice]) => ({
        name: `${bold(choice.name)}\n    ${dim(choice.descriptions.join('\n    '))}`,
        value,
    }));
};

export const getTypeOfPlugin = async (typeInput?: TypeOfPlugin) => {
    if (typeInput) {
        if (!typesOfPlugin.includes(typeInput)) {
            console.error(`Invalid plugin type: ${red(typeInput)}`);
        } else {
            return typeInput;
        }
    }

    return select<TypeOfPlugin>({
        message: 'What type of plugin do you want to create?',
        choices: listChoices(pluginTypes),
    });
};

export const validateHooks = (pluginType: TypeOfPlugin, hooksToValidate: AnyHook[]): AnyHook[] => {
    const validHooks: AnyHook[] = [];
    const invalidHooks: AnyHook[] = [];

    const refHooks =
        pluginType === 'internal'
            ? allHookNames
            : pluginType === 'universal'
              ? universalHookNames
              : bundlerHookNames;

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
    return validHooks;
};

export const getHooksToInclude = async (
    pluginType: TypeOfPlugin,
    hooksInput?: AnyHook[],
): Promise<AnyHook[]> => {
    if (hooksInput && hooksInput.length) {
        return validateHooks(pluginType, hooksInput);
    }

    // List all hooks available in the universal plugin framework.
    const hooksContent = listChoices(universalHooks);
    const bundlersContent = listChoices(bundlerHooks);
    const allContent = listChoices(allHooks);

    const choices =
        pluginType === 'internal'
            ? allContent
            : pluginType === 'universal'
              ? hooksContent
              : bundlersContent;

    return checkbox<AnyHook>({
        message: `Which ${pluginType !== 'bundler' ? 'hooks' : 'bundlers'} do you want to support?`,
        pageSize: 25,
        choices: choices.map((choice) => ({ ...choice, checked: false })),
    });
};
