// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { MD_TOC_KEY, MD_TOC_OMIT_KEY } from '@dd/tools/constants';
import { getCamelCase, getPackageJsonData, getPascalCase, getTitle } from '@dd/tools/helpers';
import outdent from 'outdent';

import { getHookTemplate } from './hooks';
import type { Context, File } from './types';

export const getFiles = (context: Context): File[] => {
    const plugin = context.plugin;
    const title = getTitle(plugin.slug);
    const description =
        context.description || `${title} plugins distributed with Datadog's Build Plugins.`;
    const pascalCase = getPascalCase(plugin.slug);
    const camelCase = getCamelCase(plugin.slug);
    const pkg = getPackageJsonData();

    const files: File[] = [];

    if (context.type !== 'internal') {
        files.push(
            {
                name: `${plugin.location}/src/index.ts`,
                content: (ctx) => {
                    const hooksContent = ctx.hooks.map((hook) => getHookTemplate(hook)).join('\n');
                    return outdent`
                        import type { GlobalContext, GetPlugins, Options } from '@dd/core/types';

                        import { CONFIG_KEY, PLUGIN_NAME } from './constants';
                        import type { ${pascalCase}Options, ${pascalCase}OptionsWithDefaults } from './types';

                        export { CONFIG_KEY, PLUGIN_NAME };

                        export const helpers = {
                            // Add the helpers you'd like to expose here.
                        };

                        export type types = {
                            // Add the types you'd like to expose here.
                            ${pascalCase}Options: ${pascalCase}Options;
                        };

                        // Deal with validation and defaults here.
                        export const validateOptions = (config: Options): ${pascalCase}OptionsWithDefaults => {
                            const validatedOptions: ${pascalCase}OptionsWithDefaults = {
                                disabled: !config[CONFIG_KEY],
                                ...config[CONFIG_KEY]
                            };
                            return validatedOptions;
                        };

                        export const getPlugins: GetPlugins = (
                            opts: Options,
                            context: GlobalContext,
                        ) => {
                            // Verify configuration.
                            const options = validateOptions(opts);

                            // If the plugin is disabled, return an empty array.
                            if (options.disabled) {
                                return [];
                            }

                            const log = context.getLogger(PLUGIN_NAME);

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
                        export type ${pascalCase}Options = {
                            disabled?: boolean;
                        };

                        export type ${pascalCase}OptionsWithDefaults = Required<${pascalCase}Options>;
                    `;
                },
            },
            {
                name: `${plugin.location}/src/index.test.ts`,
                content: () => {
                    return outdent`
                        import { getPlugins } from '@dd/${plugin.slug}-plugin';
                        import { getContextMock } from '@dd/tests/_jest/helpers/mocks';

                        describe('${title} Plugin', () => {
                            describe('getPlugins', () => {
                                test('Should not initialize the plugin if disabled', async () => {
                                    expect(getPlugins({ ${camelCase}: { disabled: true } }, getContextMock())).toHaveLength(0);
                                    expect(getPlugins({}, getContextMock())).toHaveLength(0);
                                });

                                test('Should initialize the plugin if enabled', async () => {
                                    expect(getPlugins({ ${camelCase}: { disabled: false } }, getContextMock()).length).toBeGreaterThan(0);
                                });
                            });
                        });
                    `;
                },
            },
        );
    } else if (context.type === 'internal') {
        files.push({
            name: `${plugin.location}/src/index.ts`,
            content: (ctx) => {
                const hooksContent = ctx.hooks.map((hook) => getHookTemplate(hook)).join('\n');
                return outdent`
                    import type { GetInternalPlugins, GetInternalPluginsArg } from '@dd/core/types';

                    import { PLUGIN_NAME } from './constants';

                    export { PLUGIN_NAME };

                    export const get${pascalCase}Plugins: GetInternalPlugins = (arg: GetInternalPluginsArg) => {
                        const { context } = arg;
                        const log = context.getLogger(PLUGIN_NAME);
                        return [
                            {
                                name: PLUGIN_NAME,
                                ${hooksContent}
                            },
                        ];
                    };
                `;
            },
        });
    }

    files.push(
        {
            name: `${plugin.location}/src/constants.ts`,
            content: (ctx) => {
                return outdent`
                    import type { PluginName } from '@dd/core/types';

                    ${context.type !== 'internal' ? `export const CONFIG_KEY = '${camelCase}' as const;` : ''}
                    export const PLUGIN_NAME: PluginName = 'datadog-${ctx.plugin.slug}-plugin' as const;
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
                            "@dd/core": "workspace:*"
                        }
                    }
                `;
            },
        },
        {
            name: `${plugin.location}/README.md`,
            content: () => {
                const nonInternalContent = outdent`

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

                return outdent`
                # ${title} Plugin ${MD_TOC_OMIT_KEY}

                ${description}
                ${context.type !== 'internal' ? nonInternalContent : ''}
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
    );

    return files;
};
