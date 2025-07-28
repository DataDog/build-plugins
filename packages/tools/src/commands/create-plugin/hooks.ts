// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { dim, green, grey, yellow } from '@dd/tools/helpers';
import { outdent } from 'outdent';

import type {
    AllHookList,
    AnyHook,
    BundlerHook,
    Choice,
    TypeOfPlugin,
    UniversalHook,
} from './types';

export const pluginTypes: Record<TypeOfPlugin, Choice> = {
    universal: {
        name: `[${green('Recommended')}] Universal Plugin`,
        descriptions: [
            'Create a customer facing plugin.',
            'One implementation for all bundlers.',
            'It will use universal hooks that are supported by all bundlers.',
        ],
    },
    bundler: {
        name: `[${yellow('Discouraged')}] Bundler Specific Plugin`,
        descriptions: [
            'Create a customer facing plugin.',
            'One implementation PER bundler.',
            "It will use each bundler's own plugin API. No sugar included.",
        ],
    },
    internal: {
        name: `[${grey('Power User')}] Internal Plugin`,
        descriptions: [
            'Create a plugin to be used by other plugins.',
            'It will have access to every hook available.',
        ],
    },
};

export const bundlerHooks: Record<BundlerHook, Choice> = {
    webpack: { name: 'Webpack', descriptions: ['Apply the plugin only to Webpack.'] },
    esbuild: { name: 'ESBuild', descriptions: ['Apply the plugin only to ESBuild.'] },
    vite: { name: 'Vite', descriptions: ['Apply the plugin only to Vite.'] },
    rollup: { name: 'Rollup', descriptions: ['Apply the plugin only to Rollup.'] },
    rspack: { name: 'Rspack', descriptions: ['Apply the plugin only to Rspack.'] },
    farm: { name: 'Farm', descriptions: ['Apply the plugin only to Farm.'] },
};

export const universalHooks: Record<UniversalHook, Choice> = {
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
    ...bundlerHooks,
    ...universalHooks,
};

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
            // Unplugin v2 uses a filter/handler pattern for better performance.
            // The filter is evaluated once at build time, not for every file.
            load: {
                filter: {
                    // Use static patterns for optimal performance
                    id: {
                        // String patterns with glob support
                        include: ['**/*.virtual', '**/*.generated.ts'],
                    },
                    // Or use a RegExp
                    // id: /\\.virtual$|\\?virtual/,
                },
                async handler(id) {
                    ${description}
                    // https://rollupjs.org/plugin-development/#load
                    return {
                        code: \`export default "loaded from \${id}"\`,
                        map: null, // Provide source map if applicable
                    };
                },
            },
            `;
        }
        case 'transform': {
            return outdent`
            // Unplugin v2 uses a filter/handler pattern for better performance.
            // The filter is evaluated once at build time, not for every file.
            transform: {
                filter: {
                    // Use static patterns for optimal performance
                    id: {
                        // String patterns with glob support
                        include: ['**/*.ts', '**/*.tsx'],
                        exclude: ['node_modules/**', '**/*.test.ts'],
                    },
                    // Or use a RegExp
                    // id: /\\.[jt]sx?$/,
                },
                async handler(code, id) {
                    ${description}
                    // https://rollupjs.org/plugin-development/#transform

                    // Example: Simple transformation
                    const transformedCode = code.replace(/console\\.log/g, 'console.debug');

                    return {
                        code: transformedCode,
                        map: null, // Provide source map if you're modifying the code
                    };
                },
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
