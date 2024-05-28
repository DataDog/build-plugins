// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import outdent from 'outdent';

import { MD_TOC_KEY, MD_TOC_OMIT_KEY } from '../../constants';
import { getPackageJsonData, getPascalCase, getTitle } from '../../helpers';
import type { Context, File } from '../../types';

const getTemplates = (context: Context): File[] => {
    const plugin = context.plugin;
    const testRoot = `packages/tests/src/plugins/${plugin.slug}`;
    const title = getTitle(plugin.slug);
    const pascalCase = getPascalCase(plugin.slug);
    const pkg = getPackageJsonData();
    const webpackPeerVersions = getPackageJsonData('webpack').peerDependencies.webpack;
    const esbuildPeerVersions = getPackageJsonData('esbuild').peerDependencies.esbuild;

    return [
        {
            name: `${plugin.location}/src/constants.ts`,
            content: (ctx) => {
                return outdent`
                    export const CONFIG_KEY = '${ctx.plugin.slug}' as const;
                    export const PLUGIN_NAME = '${ctx.plugin.slug}-plugin' as const;
                `;
            },
        },
        {
            name: `${plugin.location}/src/index.ts`,
            content: (ctx) => {
                return outdent`
                    import type { GetPlugins } from '@datadog/build-plugins-core/types';

                    import { PLUGIN_NAME } from './constants';
                    ${ctx.esbuild ? `import { getEsbuildPlugin } from './esbuild-plugin';` : ''}
                    ${ctx.webpack ? `import { getWebpackPlugin } from './webpack-plugin';` : ''}
                    import type { OptionsWith${pascalCase}Enabled } from './types';

                    export { CONFIG_KEY, PLUGIN_NAME } from './constants';

                    export const helpers = {
                        // Add helpers you'd like to expose here.
                    };

                    export const getPlugins: GetPlugins<OptionsWith${pascalCase}Enabled> = (
                        opt: OptionsWith${pascalCase}Enabled,
                    ) => {
                        return [
                            {
                                name: PLUGIN_NAME,
                                ${ctx.esbuild ? `esbuild: getEsbuildPlugin(opt),` : ''}
                                ${ctx.webpack ? `webpack: getWebpackPlugin(opt),` : ''}
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
                    import type { GetPluginsOptionsWithCWD } from '@datadog/build-plugins-core/types';

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
                        "description": "${title} plugin distributed with Datadog's Build Plugins.",
                        "homepage": "https://github.com/DataDog/build-plugin/tree/main/${plugin.location}#readme",
                        "repository": {
                            "type": "git",
                            "url": "https://github.com/DataDog/build-plugin",
                            "directory": "${plugin.location}"
                        },
                        "exports": {
                            ".": "./src/index.ts",
                            ${ctx.esbuild ? `"./esbuild-plugin/*": "./src/esbuild-plugin/*.ts",` : ''}
                            ${ctx.webpack ? `"./webpack-plugin/*": "./src/webpack-plugin/*.ts",` : ''}
                            "./*": "./src/*.ts"
                        },
                        "scripts": {
                            "typecheck": "tsc --noEmit"
                        },
                        "dependencies": {
                            "@datadog/build-plugins-core": "${pkg.dependencies['@datadog/build-plugins-core']}",
                            ${ctx.esbuild ? `"esbuild": "${pkg.dependencies.esbuild}",` : ''}
                            ${ctx.webpack ? `"webpack": "${pkg.dependencies.webpack}",` : ''}
                            "unplugin": "${pkg.dependencies.unplugin}"
                        },
                        "peerDependencies": {
                            ${ctx.esbuild ? `"esbuild": "${esbuildPeerVersions}",` : ''}
                            ${ctx.webpack ? `"webpack": "${webpackPeerVersions}",` : ''}
                            "@datadog/build-plugins-core": "${pkg.peerDependencies['@datadog/build-plugins-core']}"
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

                This plugin is distributed with Datadog's Build Plugins. (please edit this line)

                <!-- The title and the following line will both be added to the root README.md  -->

                ## Table of content ${MD_TOC_OMIT_KEY}

                <!-- This is auto generated with yarn cli docs -->

                ${MD_TOC_KEY}
                ${MD_TOC_KEY}
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
        {
            name: `${testRoot}/webpack-plugin/index.test.ts`,
            condition: (ctx) => ctx.tests && ctx.webpack,
            content: (ctx) => {
                return outdent`
                    import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
                    import { mockCompiler, mockOptions } from '@dd/tests/testHelpers';

                    describe('${title} Webpack Plugin', () => {
                        test('It should not execute if disabled', () => {
                            const compiler = {
                                ...mockCompiler,
                                hooks: {
                                    thisCompilation: {
                                        ...mockCompiler.hooks.thisCompilation,
                                        tap: jest.fn(),
                                    },
                                },
                            };

                            const plugin = datadogWebpackPlugin({
                                ...mockOptions,
                                '${ctx.plugin.slug}': {
                                    disabled: true,
                                },
                            });

                            // @ts-expect-error - webpack 4 and 5 nonsense.
                            plugin.apply(compiler);

                            expect(compiler.hooks.thisCompilation.tap).not.toHaveBeenCalled();
                        });
                    });
                `;
            },
        },
        {
            name: `${testRoot}/esbuild-plugin/index.test.ts`,
            condition: (ctx) => ctx.tests && ctx.esbuild,
            content: (ctx) => {
                return outdent`
                    import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
                    import { mockBuild, mockOptions } from '@dd/tests/testHelpers';

                    describe('Telemetry ESBuild Plugin', () => {
                        test('It should not execute if disabled', () => {
                            const plugin = datadogEsbuildPlugin({
                                ...mockOptions,
                                '${ctx.plugin.slug}': { disabled: true },
                            });

                            plugin.setup(mockBuild);

                            expect(mockBuild.onEnd).not.toHaveBeenCalled();
                        });
                    });
                `;
            },
        },
        {
            name: `${plugin.location}/src/webpack-plugin/index.ts`,
            condition: (ctx) => ctx.webpack,
            content: () => {
                return outdent`
                    import type { UnpluginOptions } from 'unplugin';

                    import type { OptionsWith${pascalCase}Enabled } from '../types';

                    export const getWebpackPlugin = (opt: OptionsWith${pascalCase}Enabled): UnpluginOptions['webpack'] => {
                        return async (compiler) => {
                            // Write your plugin here.
                        };
                    };
                `;
            },
        },
        {
            name: `${plugin.location}/src/esbuild-plugin/index.ts`,
            condition: (ctx) => ctx.esbuild,
            content: () => {
                return outdent`
                    import type { UnpluginOptions } from 'unplugin';

                    import type { OptionsWith${pascalCase}Enabled } from '../types';

                    export const getEsbuildPlugin = (opt: OptionsWith${pascalCase}Enabled): UnpluginOptions['esbuild'] => {
                        return {
                            setup: (build) => {
                                // Write your plugin here.
                            },
                        };
                    };
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