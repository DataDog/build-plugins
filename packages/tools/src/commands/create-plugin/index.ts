// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Workspace } from '@dd/tools/types';
import { Command, Option } from 'clipanion';
import * as t from 'typanion';

import { allHookNames, typesOfPlugin } from './constants';
import type { Context, AnyHook, TypeOfPlugin } from './types';

class CreatePlugin extends Command {
    static paths = [['create-plugin']];

    static usage = Command.Usage({
        category: `Contribution`,
        description: `Bootstrap your new plugin with all the necessary files.`,
        details: `
            This command will help you create the files you need to follow the best practices of this repository.

            You will be able to pick which type of plugin you want to build and which type of files you want to include.
        `,
        examples: [
            [`Use the full wizard`, `$0 create-plugin`],
            [`Pass a name directly`, `$0 create-plugin --name "Error Tracking"`],
        ],
    });

    name?: string = Option.String('--name', { description: 'Name of the plugin to create.' });
    description?: string = Option.String('--description', {
        description: 'Description of the plugin to create.',
    });
    type?: TypeOfPlugin = Option.String('--type', {
        description: 'Type of plugin to create, "universal" or "bundler".',
        validator: t.isEnum(typesOfPlugin),
    });
    hooks?: AnyHook[] = Option.Array('--hook', {
        description: 'Hooks to include in the plugin.',
        validator: t.isArray(t.isEnum(allHookNames)),
    });
    codeowners?: string[] = Option.Array('--codeowner', {
        description: 'Codeowners of the plugin to create.',
    });
    // Mostly used in tests, to avoid running outside of Jest's environment.
    noAutofix?: boolean = Option.Boolean('--no-autofix', false, {
        description: 'Autofix the code after creation.',
    });
    noAsk?: boolean = Option.Boolean('--no-ask', false, {
        description: 'Skip interactive prompts and use defaults for missing values.',
    });

    async createFiles(context: Context) {
        const { getFiles } = await import('./templates');
        const { ROOT } = await import('@dd/tools/constants');
        const { green } = await import('@dd/tools/helpers');
        const { outputFileSync } = await import('@dd/core/helpers/fs');
        const path = await import('path');

        const filesToCreate = getFiles(context);
        for (const file of filesToCreate) {
            console.log(`Creating ${green(file.name)}.`);
            outputFileSync(path.resolve(ROOT, file.name), file.content(context));
        }
    }

    async injectCodeowners(context: Context) {
        const { outdent } = await import('outdent');
        const { ROOT } = await import('@dd/tools/constants');
        const { green, getTitle } = await import('@dd/tools/helpers');
        const { outputFileSync } = await import('@dd/core/helpers/fs');
        const fs = await import('fs');
        const path = await import('path');

        const codeownersPath = path.resolve(ROOT, '.github/CODEOWNERS');
        console.log(`Injecting ${green(context.plugin.slug)} into ${green(codeownersPath)}.`);
        const codeowners = fs.readFileSync(codeownersPath, 'utf-8');
        const pluginPathToAdd = `packages/plugins/${context.plugin.slug}`;
        const paddingPlugin = ' '.repeat(70 - pluginPathToAdd.length);
        const newCodeowners = outdent`
            ${codeowners.trim()}

            # ${getTitle(context.plugin.slug)}
            ${pluginPathToAdd}${paddingPlugin}${context.codeowners}
        `;
        outputFileSync(codeownersPath, newCodeowners);
    }

    async execute() {
        const { outdent } = await import('outdent');
        const { getName, getHooksToInclude, getDescription, getTypeOfPlugin, getCodeowners } =
            await import('./ask');
        const { execute, green, blue, dim } = await import('../../helpers');

        const name = await getName(this.name, this.noAsk);
        const description = await getDescription(this.description, this.noAsk);
        const codeowners = await getCodeowners(this.codeowners, this.noAsk);
        const typeOfPlugin = await getTypeOfPlugin(this.type, this.noAsk);
        const hooks = await getHooksToInclude(typeOfPlugin, this.hooks, this.noAsk);

        const packageName = `@dd/${typeOfPlugin === 'internal' ? 'internal-' : ''}${name}-plugin`;
        const plugin: Workspace = {
            name: packageName,
            slug: name,
            location: `packages/plugins/${name}`,
        };

        const context: Context = {
            plugin,
            description,
            codeowners,
            hooks,
            type: typeOfPlugin,
        };

        // Create all the necessary files.
        await this.createFiles(context);

        // Inject codeowners.
        await this.injectCodeowners(context);

        if (!this.noAutofix) {
            // Update the locks.
            console.log(`Running ${green('yarn')}.`);
            await execute('yarn', []);

            // Run the integrity check.
            console.log(`Running ${green('yarn cli integrity')}.`);
            await execute('yarn', ['cli', 'integrity', '--no-failure']);
        } else {
            console.log(`Skipping ${green('yarn')} and ${green('yarn cli integrity')}.`);
        }

        console.log(outdent`


            ${green('All done!')}

            Your plugin ${green(name)} has been created with the following options:
                - Description: ${green(description)}
                - Codeowners: ${green(codeowners)}

            You can now edit ${green(`${plugin.location}/src/index.ts`)} to add your plugin logic.
            For more details on how to develop a plugin, check the documentation of ${blue('Unplugin')} (${dim('https://unplugin.unjs.io/guide/#supported-hooks')}).

            ${blue('NOTE:')} You will need to ${green('restart the ESLint server')} in VSCode.


        `);
    }
}

export default [CreatePlugin];
