// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { dim } from '@dd/tools/helpers';
import { outdent } from 'outdent';

import type { AllHookList, AnyHook, BundlerHook, Hook, UniversalHook } from './types';

export const bundlers: Record<BundlerHook, Hook> = {
    webpack: { name: 'Webpack', descriptions: ['Apply the plugin only to Webpack.'] },
    esbuild: { name: 'ESBuild', descriptions: ['Apply the plugin only to ESBuild.'] },
    vite: { name: 'Vite', descriptions: ['Apply the plugin only to Vite.'] },
    rollup: { name: 'Rollup', descriptions: ['Apply the plugin only to Rollup.'] },
    rspack: { name: 'Rspack', descriptions: ['Apply the plugin only to Rspack.'] },
    farm: { name: 'Farm', descriptions: ['Apply the plugin only to Farm.'] },
};

export const hooks: Record<UniversalHook, Hook> = {
    enforce: {
        name: `Plugin Ordering (${dim('enforce')})`,
        descriptions: [
            'Enforce when the plugin will be executed.',
            'Not supported by Rollup and ESBuild.',
        ],
    },
    buildStart: {
        name: `Build Start (${dim('buildStart')})`,
        descriptions: ['Execute code before the build starts.'],
    },
    resolveId: {
        name: `Custom Resolver (${dim('resolveId')})`,
        descriptions: ['Define a custom resolver.'],
    },
    load: { name: `Custom Loader (${dim('load')})`, descriptions: ['Define a custom loader.'] },
    transform: {
        name: `Transform (${dim('transform')})`,
        descriptions: ['Transform individual modules.'],
    },
    watchChange: {
        name: `Change Detection (${dim('watchChange')})`,
        descriptions: [
            'Notifies whenever a change is detected.',
            'Not supported by ESBuild and Rspack.',
        ],
    },
    buildEnd: {
        name: `End Build (${dim('buildEnd')})`,
        descriptions: ['Execute code after the build ends.'],
    },
    writeBundle: {
        name: `Bundle Write (${dim('writeBundle')})`,
        descriptions: ['Execute code after the bundle is written.'],
    },
};

export const allHooks: AllHookList = {
    ...hooks,
    ...bundlers,
};

export const allHooksNames = Object.keys(allHooks) as AnyHook[];

export const getHookTemplate = (hook: AnyHook) => {
    const description = allHooks[hook].descriptions.map((desc) => `// ${desc}`).join('\n');
    switch (hook) {
        case 'enforce': {
            return outdent`
            ${description}
            // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
            enforce: 'pre',
            `;
        }
        case 'buildStart': {
            return outdent`
            async buildStart() {
                ${description}
                // https://rollupjs.org/plugin-development/#buildstart
            },
            `;
        }
        case 'resolveId': {
            return outdent`
            async resolveId(source, importer, options) {
                ${description}
                // https://rollupjs.org/plugin-development/#resolveid
                return {
                    id: 'new-id',
                };
            },
            `;
        }
        case 'load': {
            return outdent`
            // webpack's id filter is outside of loader logic,
            // an additional hook is needed for better perf on webpack
            loadInclude(id) {
                return id.endsWith('main.ts');
            },
            async load(id) {
                ${description}
                // https://rollupjs.org/plugin-development/#load
                return {
                    code: '',
                };
            },
            `;
        }
        case 'transform': {
            return outdent`
            // webpack's id filter is outside of loader logic,
            // an additional hook is needed for better perf on webpack
            transformInclude(id) {
                return id.endsWith('main.ts');
            },
            async transform(code, id) {
                ${description}
                // https://rollupjs.org/plugin-development/#transform
                return {
                    code: '',
                };
            },
            `;
        }
        case 'watchChange': {
            return outdent`
            async watchChange(id, change) {
                ${description}
                // https://rollupjs.org/plugin-development/#watchchange
            },
            `;
        }
        case 'buildEnd': {
            return outdent`
            async buildEnd() {
                ${description}
                // https://rollupjs.org/plugin-development/#buildend
            },
            `;
        }
        case 'writeBundle': {
            return outdent`
            async writeBundle() {
                ${description}
                // https://rollupjs.org/plugin-development/#writebundle
            },
            `;
        }
        case 'webpack': {
            return outdent`
            webpack(compiler) {
                ${description}
                // https://webpack.js.org/contribute/writing-a-plugin/
            },
            `;
        }
        case 'esbuild': {
            return outdent`
            esbuild: {
                ${description}
                // https://esbuild.github.io/plugins/#build-plugins

                /* Change the filter of onResolve and onLoad
                        onResolveFilter?: RegExp,
                        onLoadFilter?: RegExp,

                   Tell esbuild how to interpret the contents.
                   By default Unplugin tries to guess the loader
                   from file extension (eg: .js -> "js", .jsx -> 'jsx')
                        loader?: (Loader | (code: string, id: string) => Loader)

                   Or you can completely replace the setup logic
                        setup?: EsbuildPlugin.setup,
                */
            },
            `;
        }
        case 'vite': {
            return outdent`
            vite: {
                ${description}
                // https://vitejs.dev/guide/api-plugin.html
            },
            `;
        }
        case 'rollup': {
            return outdent`
            rollup: {
                ${description}
                // https://rollupjs.org/plugin-development/
            },
            `;
        }
        case 'rspack': {
            return outdent`
            rspack(compiler) {
                ${description}
                // https://www.rspack.dev/guide/features/plugin#write-a-plugin
            },
            `;
        }
        case 'farm': {
            return outdent`
            farm: {
                ${description}
                // https://www.farmfe.org/docs/plugins/writing-plugins/js-plugin
            },
            `;
        }
    }
};
