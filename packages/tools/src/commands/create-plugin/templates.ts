// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { MD_TOC_KEY, MD_TOC_OMIT_KEY } from '@dd/tools/constants';
import { getPackageJsonData, getPascalCase, getTitle } from '@dd/tools/helpers';
import type { Context, File } from '@dd/tools/types';
import outdent from 'outdent';

import { getHookTemplate } from './hooks';

const getTemplates = (context: Context): File[] => {
    const plugin = context.plugin;
    const title = getTitle(plugin.slug);
    const description =
        context.description || `${title} plugins distributed with Datadog's Build Plugins.`;
    const pascalCase = getPascalCase(plugin.slug);
    const camelCase = pascalCase[0].toLowerCase() + pascalCase.slice(1);
    const pkg = getPackageJsonData();

    return [
        {
            name: `${plugin.location}/src/constants.ts`,
            content: (ctx) => {
                return outdent`
                    import type { PluginName } from '@dd/core/types';

                    export const CONFIG_KEY = '${camelCase}' as const;
                    export const PLUGIN_NAME: PluginName = 'datadog-${ctx.plugin.slug}-plugin' as const;
                `;
            },
        },
        {
            name: `${plugin.location}/src/index.ts`,
            content: (ctx) => {
                const hooksContent = ctx.hooks.map((hook) => getHookTemplate(hook)).join('\n');
                return outdent`
                    import type { GetPlugins } from '@dd/core/types';

                    import { CONFIG_KEY, PLUGIN_NAME } from './constants';
                    import type { OptionsWith${pascalCase}Enabled, ${pascalCase}Options, ${pascalCase}OptionsEnabled } from './types';

                    export { CONFIG_KEY, PLUGIN_NAME };

                    export const helpers = {
                        // Add the helpers you'd like to expose here.
                    };

                    export type types = {
                        // Add the types you'd like to expose here.
                        ${pascalCase}Options: ${pascalCase}Options;
                        OptionsWith${pascalCase}Enabled: OptionsWith${pascalCase}Enabled;
                    };

                    // Deal with validation and defaults here.
                    export const validateOptions = (config: Partial<OptionsWith${pascalCase}Enabled>): ${pascalCase}OptionsEnabled => {
                        const validatedOptions: ${pascalCase}OptionsEnabled = config[CONFIG_KEY] || { disabled: false };
                        return validatedOptions;
                    };

                    export const getPlugins: GetPlugins<OptionsWith${pascalCase}Enabled> = (
                        opt: OptionsWith${pascalCase}Enabled,
                    ) => {
                        return [
                            {
                                name: PLUGIN_NAME,
                                ${hooksContent}
                            },
                        ];
                    };
                `;
            },
        },
        {
            name: `${plugin.location}/src/types.ts`,
            content: () => {
                return outdent`
                    import type { GetPluginsOptionsWithCWD } from '@dd/core/types';

                    import type { CONFIG_KEY } from './constants';

                    export type ${pascalCase}Options = {
                        disabled?: boolean;
                    };

                    export interface ${pascalCase}OptionsEnabled extends ${pascalCase}Options {
                        disabled?: false;
                    }

                    export interface OptionsWith${pascalCase}Enabled extends GetPluginsOptionsWithCWD {
                        [CONFIG_KEY]: ${pascalCase}OptionsEnabled;
                    }
                `;
            },
        },
        {
            name: `${plugin.location}/package.json`,
            content: (ctx) => {
                return outdent`
                    {
                        "name": "${ctx.plugin.name}",
                        "packageManager": "${pkg.packageManager}",
                        "license": "MIT",
                        "private": true,
                        "author": "Datadog",
                        "description": "${description}",
                        "homepage": "https://github.com/DataDog/build-plugins/tree/main/${plugin.location}#readme",
                        "repository": {
                            "type": "git",
                            "url": "https://github.com/DataDog/build-plugins",
                            "directory": "${plugin.location}"
                        },
                        "exports": {
                            ".": "./src/index.ts",
                            "./*": "./src/*.ts"
                        },
                        "scripts": {
                            "typecheck": "tsc --noEmit"
                        },
                        "dependencies": {
                            "@dd/core": "workspace:*",
                            "unplugin": "${pkg.dependencies.unplugin}"
                        }
                    }
                `;
            },
        },
        {
            name: `${plugin.location}/README.md`,
            content: () => {
                return outdent`
                # ${title} Plugin ${MD_TOC_OMIT_KEY}

                ${description}

                <!-- The title and the following line will both be added to the root README.md  -->

                ## Table of content ${MD_TOC_OMIT_KEY}

                <!-- This is auto generated with yarn cli integrity -->

                ${MD_TOC_KEY}
                ${MD_TOC_KEY}

                ## Configuration

                \`\`\`ts
                ${camelCase}?: {
                    disabled?: boolean;
                }
                \`\`\`
                `;
            },
        },
        {
            name: `${plugin.location}/tsconfig.json`,
            content: () => {
                return outdent`
                    {
                        "extends": "../../../tsconfig.json",
                        "compilerOptions": {
                            "baseUrl": "./",
                            "rootDir": "./",
                            "outDir": "./dist"
                        },
                        "include": ["**/*"],
                        "exclude": ["dist", "node_modules"]
                    }
                `;
            },
        },
    ];
};

export const getFiles = (context: Context): File[] => {
    // Adding the files to create.
    const templates = getTemplates(context);
    const files = [];

    for (const template of templates) {
        if (!template.condition || template.condition(context)) {
            files.push(template);
        }
    }

    return files;
};
