import fs from 'fs-extra';
import outdent from 'outdent';
import path from 'path';

import { ROOT } from '../../helpers';

export type Context = {
    webpack: boolean;
    esbuild: boolean;
    tests: boolean;
    name: string;
};

type File = {
    name: string;
    condition?: (context: Context) => boolean;
    content: (context: Context) => string;
};

export const getTitle = (name: string): string =>
    name
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');

export const getUpperCase = (name: string): string =>
    getTitle(name).toUpperCase().replace(/ /g, '_');

export const getPascalCase = (name: string): string => getTitle(name).replace(/ /g, '');

export const getPackageJsonData = (): any => {
    const packageJson = fs.readJSONSync(
        path.resolve(ROOT, 'packages/plugins/telemetry/package.json'),
    );
    return packageJson;
};

const getTemplates = (context: Context): File[] => {
    const pluginRoot = `packages/plugins/${context.name}`;
    const testRoot = `packages/tests/src/plugins/${context.name}`;
    const title = getTitle(context.name);
    const pascalCase = getPascalCase(context.name);
    const pkg = getPackageJsonData();

    return [
        {
            name: `${pluginRoot}/src/constants.ts`,
            content: (ctx) => {
                return outdent`
                    export const CONFIG_KEY = '${ctx.name}' as const;
                    export const PLUGIN_NAME = '${ctx.name}-plugin' as const;
                `;
            },
        },
        {
            name: `${pluginRoot}/src/index.ts`,
            content: (ctx) => {
                return outdent`
                    import type { GetPlugins } from '@datadog/build-plugins-core/types';

                    import { PLUGIN_NAME } from './constants';
                    ${ctx.esbuild ? `import { getEsbuildPlugin } from './esbuild-plugin';` : ''}
                    ${ctx.webpack ? `import { getWebpackPlugin } from './webpack-plugin';` : ''}
                    import type { OptionsWith${pascalCase}Enabled } from './types';

                    export { CONFIG_KEY, PLUGIN_NAME } from './constants';

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
            name: `${pluginRoot}/src/types.ts`,
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
            name: `${pluginRoot}/package.json`,
            content: (ctx) => {
                return outdent`
                    {
                        "name": "@dd/${ctx.name}-plugin",
                        "packageManager": "${pkg.packageManager}",
                        "license": "MIT",
                        "private": true,
                        "author": "Datadog",
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
                            ${ctx.esbuild ? `"esbuild": "*",` : ''}
                            ${ctx.webpack ? `"webpack": "*",` : ''}
                            "@datadog/build-plugins-core": "${pkg.peerDependencies['@datadog/build-plugins-core']}"
                        }
                    }
                `;
            },
        },
        {
            name: `${pluginRoot}/README.md`,
            content: () => {
                return `# ${title} Plugin`;
            },
        },
        {
            name: `${pluginRoot}/tsconfig.json`,
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
                                '${ctx.name}': {
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
                                '${ctx.name}': { disabled: true },
                            });

                            plugin.setup(mockBuild);

                            expect(mockBuild.onEnd).not.toHaveBeenCalled();
                        });
                    });
                `;
            },
        },
        {
            name: `${pluginRoot}/src/webpack-plugin/index.ts`,
            condition: (ctx) => ctx.webpack,
            content: () => {
                return `
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
            name: `${pluginRoot}/src/esbuild-plugin/index.ts`,
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
