import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';

import { green, slugify } from '../../helpers';
import type { Answers } from '../../types';

export const askName = async (nameInput?: string) => {
    let slug;

    if (nameInput) {
        slug = slugify(nameInput);
    } else {
        const name = await input({ message: 'Enter the name of your plugin:' });
        slug = slugify(name);
    }

    console.log(`Will use ${green(slug)} as the plugin's name.`);
    return slug;
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
