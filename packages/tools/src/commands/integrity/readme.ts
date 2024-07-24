// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs-extra';
import glob from 'glob';
import { outdent } from 'outdent';
import path from 'path';

import {
    MD_BUNDLERS_KEY,
    MD_CONFIGURATION_KEY,
    MD_PLUGINS_KEY,
    MD_TOC_KEY,
    MD_TOC_OMIT_KEY,
    ROOT,
} from '../../constants';
import {
    dim,
    getBundlerPicture,
    getSupportedBundlers,
    green,
    red,
    replaceInBetween,
    slugify,
} from '../../helpers';
import type { Workspace } from '../../types';

type PluginMetadata = {
    title: string;
    intro: string;
    key: string;
    config: string;
    supportedBundlers: string[];
};

type BundlerMetadata = {
    title: string;
    name: string;
    installation: string;
    usage: string;
};

const error = red('Error');
// Matches image tags individually with surrounding whitespaces.
const IMG_RX = /[\s]*<img.+?(?=\/>)\/>[\s]*/g;

const verifyReadmeExists = (pluginPath: string) => {
    const readmePath = path.resolve(ROOT, pluginPath, 'README.md');
    return fs.pathExistsSync(readmePath);
};

const getReadmeToc = (readmeContent: string) => {
    // Get all titles.
    const cleanContent = readmeContent.replace(/```[^`]+```/gm, '');
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
    const { CONFIG_KEY, getPlugins } = await import(plugin.name);
    // Load plugin's README.md file.
    const readmePath = path.resolve(ROOT, plugin.location, 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');

    // Get the title and the first paragraph.
    // Catch the first title.
    const title = readme.match(/# (.*) Plugin/)?.[1] || '';
    // Catch the first line of text after the title.
    const intro = readme.match(/# .*\n\n(.*)/)?.[1] || '';
    // Catch the first block of code (```[...]```) right after the Configuration title.
    // Using [\s\S] to match any character including new lines.
    const config = readme.match(/## Configuration[\s\S]*?```[^\n\r]+\n([\s\S]*?)\n```/)?.[1] || '';
    const formattedConfig = config
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');

    return {
        title,
        intro,
        config: formattedConfig,
        key: CONFIG_KEY,
        supportedBundlers: getSupportedBundlers(getPlugins),
    };
};

const getPluginTemplate = (plugin: Workspace, pluginMeta: PluginMetadata) => {
    const { title, intro, supportedBundlers } = pluginMeta;
    return outdent`
    ### ${title} ${supportedBundlers.map(getBundlerPicture).join(' ')}

    > ${intro}

    \`\`\`typescript
    datadogWebpackPlugin({
    ${pluginMeta.config.replace(/;/g, ',')}
    });
    \`\`\`

    <kbd>[📝 Full documentation ➡️](./${plugin.location}#readme)</kbd>
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
    const installation = readme.match(/## Installation\s*((!?[\s\S](?!##))*)/)?.[1] || '';
    const usage = readme.match(/## Usage\s*((!?[\s\S](?!##))*)/)?.[1] || '';

    return { title, name: title.toLowerCase(), usage, installation };
};

const getBundlerTemplate = (bundler: Workspace, bundlerMeta: BundlerMetadata) => {
    const { title, name, installation, usage } = bundlerMeta;
    return outdent`
    ### ${getBundlerPicture(name)} ${title}

    \`${bundler.name}\`

    #### Installation
    ${installation}

    #### Usage
    ${usage}

    <kbd>[📝 More details ➡️](./${bundler.location}#readme)</kbd>
    `;
};

const handleBundler = (bundler: Workspace, index: number) => {
    const readmePath = `${bundler.location}/README.md`;
    let list = '';
    const errors = [];

    // Verify the plugin has a README.md file.
    if (!verifyReadmeExists(bundler.location)) {
        errors.push(`[${error}] ${green(bundler.name)} is missing "${dim(readmePath)}".`);
        return {
            list,
            errors,
        };
    }

    const bundlerMeta = getBundlerMeta(bundler);
    const bundlerTemplate = getBundlerTemplate(bundler, bundlerMeta);

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

    if (index > 0) {
        list += '\n\n';
    }

    list += bundlerTemplate;

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

const handlePlugin = async (plugin: Workspace, index: number) => {
    const readmePath = `${plugin.location}/README.md`;
    let list = '';
    let configuration = '';
    const errors = [];

    // Verify the plugin has a README.md file.
    if (!verifyReadmeExists(plugin.location)) {
        errors.push(`[${error}] ${green(plugin.name)} is missing "${dim(readmePath)}".`);
        return {
            list,
            configuration,
            errors,
        };
    }

    const pluginMeta = await getPluginMetadata(plugin);
    const pluginTemplate = getPluginTemplate(plugin, pluginMeta);

    if (!pluginMeta.title) {
        errors.push(`[${error}] ${green(plugin.name)} is missing a title in "${dim(readmePath)}".`);
    }

    if (!pluginMeta.intro) {
        errors.push(
            `[${error}] ${green(plugin.name)} is missing an intro in "${dim(readmePath)}".`,
        );
    }

    if (!pluginMeta.config) {
        errors.push(
            `[${error}] ${green(plugin.name)} is missing a configuration in "${dim(readmePath)}".`,
        );
    }

    if (index > 0) {
        list += '\n\n';
        configuration += ';';
    }

    list += pluginTemplate;
    configuration += `\n${pluginMeta.config}`;

    return {
        list,
        configuration,
        errors,
    };
};

export const updateReadmes = async (plugins: Workspace[], bundlers: Workspace[]) => {
    // Read the root README.md file.
    let rootReadmeContent = fs.readFileSync(path.resolve(ROOT, 'README.md'), 'utf-8');

    let pluginsList = '';
    let bundlersList = '';
    let fullConfiguration = outdent`
    \`\`\`typescript
    {
        auth?: {
            apiKey?: string;
        };
        logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none';
    `;
    const errors: string[] = [];

    for (const [i, plugin] of plugins.entries()) {
        const { list, configuration: config, errors: pluginErrors } = await handlePlugin(plugin, i);
        pluginsList += list;
        fullConfiguration += config;
        errors.push(...pluginErrors);
    }

    for (const [i, bundler] of bundlers.entries()) {
        const { list, errors: bundlerErrors } = handleBundler(bundler, i);
        bundlersList += list;
        errors.push(...bundlerErrors);
    }

    fullConfiguration += '\n}\n```';

    rootReadmeContent = replaceInBetween(rootReadmeContent, MD_PLUGINS_KEY, pluginsList);
    rootReadmeContent = replaceInBetween(rootReadmeContent, MD_BUNDLERS_KEY, bundlersList);
    rootReadmeContent = replaceInBetween(
        rootReadmeContent,
        MD_CONFIGURATION_KEY,
        fullConfiguration,
    );

    console.log(
        `  Inject ${green('configurations')} and ${green('plugins list')} into the root ${green('README.md')}.`,
    );
    fs.writeFileSync(path.resolve(ROOT, 'README.md'), rootReadmeContent);

    return errors;
};
