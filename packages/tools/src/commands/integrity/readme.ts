// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    INTERNAL_PLUGINS_LIST,
    MD_BUNDLERS_KEY,
    MD_CONFIGURATION_KEY,
    MD_GLOBAL_CONTEXT_KEY,
    MD_PLUGINS_KEY,
    MD_TOC_KEY,
    MD_TOC_OMIT_KEY,
    ROOT,
} from '@dd/tools/constants';
import {
    dim,
    getBundlerPicture,
    getSupportedBundlers,
    green,
    isInternalPluginWorkspace,
    red,
    replaceInBetween,
    slugify,
} from '@dd/tools/helpers';
import type { Workspace } from '@dd/tools/types';
import fs from 'fs';
import { glob } from 'glob';
import { outdent } from 'outdent';
import path from 'path';

type PluginMetadata = {
    name: string;
    title: string;
    intro: string;
    key: string;
    internal: boolean;
    config: string;
    supportedBundlers: string[];
};

type BundlerMetadata = {
    title: string;
    name: string;
    installation: string;
    usage: string;
};

const README_EXCEPTIONS: string[] = [];

const error = red('Error|README');
// Matches image tags individually with surrounding whitespaces.
const IMG_RX = /[\s]*<img.+?(?=\/>)\/>[\s]*/g;

const verifyReadmeExists = (pluginPath: string) => {
    const readmePath = path.resolve(ROOT, pluginPath, 'README.md');
    return fs.existsSync(readmePath);
};

const getReadmeToc = (readmeContent: string) => {
    // Remove all the code blocks to avoid collisions.
    const cleanContent = readmeContent.replace(/```([\s\S](?!```))*[\s\S]```/gm, '');
    // Get all titles.
    const titles = cleanContent.match(/^#{1,3} (.*)/gm) || [];
    // Remove ignored titles.
    let biggestTitle = 3;
    const titlesToUse = titles
        .filter((title) => !title.includes(MD_TOC_OMIT_KEY))
        .map((title) => {
            const [level, ...restOfTitle] = title.split(' ');

            // Save biggest title.
            if (level.length < biggestTitle) {
                biggestTitle = level.length;
            }

            // Also remove any pictures from the title.
            const finalTitle = restOfTitle.join(' ');
            // Image tags are replaced by "-" in GitHub's READMEs.
            const slug = slugify(finalTitle.replace(IMG_RX, '-'));

            return {
                // Remove the image tags.
                name: finalTitle.replace(IMG_RX, ''),
                slug,
                level: level.length,
            };
        });

    const toc = titlesToUse
        .map((title) => {
            const { name, slug, level } = title;
            const indent = ' '.repeat((level - biggestTitle) * 4);
            return `${indent}-   [${name}](#${slug})`;
        })
        .join('\n');

    return toc;
};

const getPluginMetadata = async (plugin: Workspace): Promise<PluginMetadata> => {
    const { CONFIG_KEY, PLUGIN_NAME, getPlugins } = await import(plugin.name);
    // Load plugin's README.md file.
    const readmePath = path.resolve(ROOT, plugin.location, 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');

    const metadata: PluginMetadata = {
        // Catch the first title.
        title: readme.match(/# (.*) Plugin/)?.[1] || '',
        // Catch the first lines of text after the title.
        // Stops at the next title (^#), comment (^<!--) or codeblock (^```).
        // using /m to catch the "^#|^<!--" part.
        intro: readme.match(/^# .*\s*(([\s\S](?!^#|^<!--|^```))*)/m)?.[1].trim() || '',
        // The exported PLUGIN_NAME for verification.
        name: PLUGIN_NAME,
        internal: isInternalPluginWorkspace(plugin),
        key: CONFIG_KEY,
        // Placeholders for plugins.
        config: '',
        supportedBundlers: [],
    };

    if (!metadata.internal) {
        // Catch the first block of code (```[...]```) right after the Configuration title.
        // Using [\s\S] to match any character including new lines.
        const config =
            readme.match(/## Configuration[\s\S]*?```[^\n\r]+\n([\s\S]*?)\n```/)?.[1] || '';
        const formattedConfig = config
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n');

        metadata.config = formattedConfig;
        metadata.supportedBundlers = getSupportedBundlers(getPlugins);
    }

    return metadata;
};

const getPluginTemplate = (plugin: Workspace, pluginMeta: PluginMetadata) => {
    const { title, intro, supportedBundlers } = pluginMeta;
    const titleContent = `### ${title}`;
    const bundlerContent = supportedBundlers.map(getBundlerPicture).join(' ');
    const configContent = pluginMeta.config
        ? outdent`

            <details>

            <summary>Configuration</summary>

            \`\`\`typescript
            datadogWebpackPlugin({
            ${pluginMeta.config.replace(/;/g, ',')}
            });
            \`\`\`

            </details>
        `
        : '';

    // Quote intro by prefixing each line with `> `.
    // Except for lines that already start with `> `.
    const quotedIntro = intro.replace(/^(> |)/gm, '> ');

    return outdent`
        ${titleContent}${bundlerContent ? ` ${bundlerContent}` : ''}

        ${quotedIntro}

        #### [📝 Full documentation ➡️](/${plugin.location}#readme)
        ${configContent}
    `;
};

const getBundlerMeta = (bundler: Workspace): BundlerMetadata => {
    // Load plugin's README.md file.
    const readmePath = path.resolve(ROOT, bundler.location, 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');

    // Catch the first title and remove the `MD_TOC_OMIT_KEY` from it.
    const title = readme.match(/# Datadog (.*) Plugin/)?.[1] || '';

    // Catch installation and usage.
    // Everything between "## (Installation|Usage)" and the next "##".
    const installation = readme.match(/## Installation\s*(([\s\S](?!##))*)/)?.[1] || '';
    const usage = readme.match(/## Usage\s*(([\s\S](?!```\n))+\n```)/)?.[1] || '';

    return { title, name: title.toLowerCase(), usage, installation };
};

const getBundlerTemplate = (bundler: Workspace, bundlerMeta: BundlerMetadata) => {
    const { title, name } = bundlerMeta;
    return outdent`- [${getBundlerPicture(name)} ${title} \`${bundler.name}\`](/${bundler.location}#readme)`;
};

const handleBundler = (bundler: Workspace, index: number) => {
    const readmePath = `${bundler.location}/README.md`;
    const errors = [];

    // Verify the plugin has a README.md file.
    if (!verifyReadmeExists(bundler.location)) {
        errors.push(`[${error}] ${green(bundler.name)} is missing "${dim(readmePath)}".`);
        return {
            list: '',
            errors,
        };
    }

    const bundlerMeta = getBundlerMeta(bundler);
    const list = getBundlerTemplate(bundler, bundlerMeta);

    if (!bundlerMeta.title) {
        errors.push(
            `[${error}] ${green(bundler.name)} is missing a title in "${dim(readmePath)}".`,
        );
    }

    if (!bundlerMeta.installation) {
        errors.push(
            `[${error}] ${green(bundler.name)} is missing an installation process in "${dim(readmePath)}".`,
        );
    }

    if (!bundlerMeta.usage) {
        errors.push(
            `[${error}] ${green(bundler.name)} is missing an usage process in "${dim(readmePath)}".`,
        );
    }

    return { errors, list };
};

export const injectTocsInAllReadmes = () => {
    // Get all the readmes of the repository.
    const readmes = glob
        .sync(`${ROOT}/**/*.md`)
        // Filter out node_modules
        .filter((file) => !file.includes('node_modules'));

    // Inject the Table of content in all of them.
    for (const readmePath of readmes) {
        const readmeContent = fs.readFileSync(readmePath, 'utf-8');

        if (!readmeContent.includes(MD_TOC_KEY)) {
            continue;
        }

        const readmeToc = getReadmeToc(readmeContent);

        console.log(`  Inject ${green('TOC')} in ${green(readmePath)}.`);
        fs.writeFileSync(readmePath, replaceInBetween(readmeContent, MD_TOC_KEY, readmeToc));
    }
};

const handlePlugin = async (plugin: Workspace) => {
    const readmePath = `${plugin.location}/README.md`;
    const errors = [];

    // Verify the plugin has a README.md file.
    if (!verifyReadmeExists(plugin.location)) {
        errors.push(`[${error}] ${green(plugin.name)} is missing "${dim(readmePath)}".`);
        return {
            list: '',
            config: '',
            internal: false,
            errors,
        };
    }

    const pluginMeta = await getPluginMetadata(plugin);
    const list = getPluginTemplate(plugin, pluginMeta);

    if (!pluginMeta.name) {
        errors.push(
            `[${error}] ${green(plugin.name)} is missing a PLUGIN_NAME in "${dim(plugin.location)}".`,
        );
    }

    if (!pluginMeta.title) {
        errors.push(`[${error}] ${green(plugin.name)} is missing a title in "${dim(readmePath)}".`);
    }

    if (!pluginMeta.intro) {
        errors.push(
            `[${error}] ${green(plugin.name)} is missing an intro in "${dim(readmePath)}".`,
        );
    }

    if (!pluginMeta.internal && !pluginMeta.config) {
        errors.push(
            `[${error}] ${green(plugin.name)} is missing a configuration in "${dim(readmePath)}".`,
        );
    }

    return {
        list,
        internal: pluginMeta.internal,
        config: pluginMeta.config,
        errors,
    };
};

const getGlobalContextType = () => {
    // Will capture the first code block after '## Global Context' up to the next title '## '.
    const RX =
        /## Global Context([\s\S](?!<pre>))+[\s\S](?<type><pre>([\s\S](?!<\/pre>\n))+\n<\/pre>)/gm;
    const coreReadmeContent = fs.readFileSync(
        path.resolve(ROOT, './packages/factory/README.md'),
        'utf-8',
    );
    return RX.exec(coreReadmeContent)?.groups?.type || '';
};

export const updateReadmes = async (plugins: Workspace[], bundlers: Workspace[]) => {
    const rootReadmePath = path.resolve(ROOT, 'README.md');
    const factoryReadmePath = path.resolve(ROOT, './packages/factory/README.md');

    // Read the README.md files.
    let rootReadmeContent = fs.readFileSync(rootReadmePath, 'utf-8');
    let factoryReadmeContent = fs.readFileSync(factoryReadmePath, 'utf-8');

    const pluginsContents: string[] = [];
    const internalPluginsContents: string[] = [];
    const bundlersContents: string[] = [];
    const configContents: string[] = [
        outdent`
            \`\`\`typescript
            {
                auth?: {
                    apiKey?: string;
                };
                customPlugins?: (options: Options, context: GlobalContext, log: Logger) => UnpluginPlugin[];
                logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none'
        `,
    ];
    const errors: string[] = [];

    for (const plugin of plugins) {
        if (README_EXCEPTIONS.includes(plugin.name)) {
            continue;
        }

        const { list, config, internal, errors: pluginErrors } = await handlePlugin(plugin);
        if (!internal) {
            pluginsContents.push(list);
            configContents.push(config);
        } else {
            internalPluginsContents.push(list);
        }
        errors.push(...pluginErrors);
    }

    for (const [i, bundler] of bundlers.entries()) {
        const { list, errors: bundlerErrors } = handleBundler(bundler, i);
        bundlersContents.push(list);
        errors.push(...bundlerErrors);
    }

    configContents.push('}\n```');

    rootReadmeContent = replaceInBetween(
        rootReadmeContent,
        MD_PLUGINS_KEY,
        pluginsContents.join('\n\n'),
    );
    factoryReadmeContent = replaceInBetween(
        factoryReadmeContent,
        INTERNAL_PLUGINS_LIST,
        internalPluginsContents.join('\n\n'),
    );
    rootReadmeContent = replaceInBetween(
        rootReadmeContent,
        MD_BUNDLERS_KEY,
        bundlersContents.join('\n'),
    );
    rootReadmeContent = replaceInBetween(
        rootReadmeContent,
        MD_CONFIGURATION_KEY,
        configContents.join(';\n'),
    );
    rootReadmeContent = replaceInBetween(
        rootReadmeContent,
        MD_GLOBAL_CONTEXT_KEY,
        getGlobalContextType(),
    );

    console.log(
        `  Inject ${green('configurations')} and ${green('plugins list')} into the ${green('READMEs')}.`,
    );
    fs.writeFileSync(rootReadmePath, rootReadmeContent);
    fs.writeFileSync(factoryReadmePath, factoryReadmeContent);

    return errors;
};
