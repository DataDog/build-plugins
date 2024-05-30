// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';

import { green, slugify } from '../../helpers';
import type { Answers } from '../../types';

export const askName = async (nameInput?: string) => {
    let slug;

    if (nameInput) {
        slug = slugify(nameInput);
    } else {
        const name = await input({
            message: 'Enter the name of your plugin:',
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
    return codeowners
        .split(/(, *| )/)
        .map((codeowner) => codeowner.replace(/^[^@]/, '@$&'))
        .join(' ');
};

export const askCodeowners = async () => {
    const codeowners = await input({
        message: 'Enter the codeowner(s) for your plugin:',
        transformer: sanitizeCodeowners,
    });
    return sanitizeCodeowners(codeowners);
};

export const askFilesToInclude = async (answers: Answers) => {
    if (answers.webpack || answers.esbuild || answers.tests) {
        const files = [];
        if (answers.tests) {
            files.push('tests');
        }
        if (answers.webpack) {
            files.push('webpack');
        }
        if (answers.esbuild) {
            files.push('esbuild');
        }
        return files;
    }

    return checkbox({
        message: 'Select what you want to include:',
        choices: [
            { name: 'Test files', value: 'tests', checked: true },
            { name: 'Webpack specifics', value: 'webpack', checked: false },
            { name: 'ESBuild specifics', value: 'esbuild', checked: false },
        ],
    });
};
