// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';
import select from '@inquirer/select';

import { bold, dim, green, slugify } from '../../helpers';
import type { HooksAnswer } from '../../types';

import type { Hook } from './hooks';
import { bundlers, hooks } from './hooks';

type TypeOfPlugin = 'universal' | 'bundler';

export const askName = async (nameInput?: string) => {
    let slug;

    if (nameInput) {
        slug = slugify(nameInput);
    } else {
        const name = await input({
            message: `Enter the name of your plugin (${dim('will auto format the name')}):`,
            transformer: (n: string) => green(slugify(n)),
        });
        slug = slugify(name);
    }

    return slug;
};

export const askDescription = async () => {
    return input({
        message: 'Enter a description for your plugin:',
        transformer: (description: string) => green(description),
    });
};

const sanitizeCodeowners = (codeowners: string) => {
    return (
        codeowners
            // Remove potential commas and spaces
            .replace(/, */, ' ')
            .split(' ')
            // Add missing @s
            .map((codeowner) => codeowner.replace(/^[^@]/, '@$&'))
            .join(' ')
    );
};

export const askCodeowners = async () => {
    const codeowners = await input({
        message: `Enter the codeowner(s) for your plugin (${dim('will auto-add @ and format the list')}):`,
        transformer: (co: string) => green(sanitizeCodeowners(co)),
    });
    return sanitizeCodeowners(codeowners);
};

const listHooks = (list: Partial<Record<HooksAnswer, Hook>>) => {
    return (Object.entries(list) as [HooksAnswer, Hook][]).map(([value, hook]) => ({
        name: `${bold(hook.name)}\n    ${dim(hook.descriptions.join('\n    '))}`,
        value,
        checked: false,
    }));
};

export const askTypeOfPlugin = async () => {
    return select<TypeOfPlugin>({
        message: 'What type of plugin do you want to create?',
        choices: [
            { name: `[${green('Recommended')}] Universal Plugin`, value: 'universal' },
            { name: `[${dim('Discouraged')}] Bundler Specific Plugin`, value: 'bundler' },
        ],
    });
};

export const askHooksToInclude = async (pluginType: TypeOfPlugin) => {
    // List all hooks available in the universal plugin framework.
    const hooksContent = listHooks(hooks);
    const bundlersContent = listHooks(bundlers);
    const choices = pluginType === 'universal' ? hooksContent : bundlersContent;
    return checkbox<HooksAnswer>({
        message: `Which ${pluginType === 'universal' ? 'hooks' : 'bundlers'} do you want to support?`,
        pageSize: 25,
        choices,
    });
};
