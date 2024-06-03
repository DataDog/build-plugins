// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import checkbox, { Separator } from '@inquirer/checkbox';
import input from '@inquirer/input';

import { bold, dim, green, slugify } from '../../helpers';
import type { HooksAnswer } from '../../types';

import type { Hook } from './hooks';
import { bundlers, hooks } from './hooks';

export const askName = async (nameInput?: string) => {
    let slug;

    if (nameInput) {
        slug = slugify(nameInput);
    } else {
        const name = await input({
            message: `Enter the name of your plugin (${dim('will auto format the name')}):`,
            transformer: slugify,
        });
        slug = slugify(name);
    }

    console.log(`Will use ${green(slug)} as the plugin's name.`);
    return slug;
};

export const askDescription = async () => {
    return input({ message: 'Enter a description for your plugin:' });
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
        transformer: sanitizeCodeowners,
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

export const askHooksToInclude = async () => {
    // List all hooks available in the universal plugin framework.
    const hooksContent = listHooks(hooks);
    const bundlersContent = listHooks(bundlers);
    return checkbox<HooksAnswer>({
        message: 'Which hooks do you need?',
        pageSize: 25,
        choices: [
            new Separator(green('\n=== [Recommended] Supported Hooks (universal plugin) ===')),
            ...hooksContent,
            new Separator(
                dim(`\nYou know what you're doing\n=== Bundlers (bundler specific plugin) ===`),
            ),
            ...bundlersContent,
        ],
    });
};
