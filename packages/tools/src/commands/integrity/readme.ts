// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs-extra';
import { outdent } from 'outdent';
import path from 'path';

import {
    MD_CONFIGURATION_KEY,
    MD_PLUGINS_KEY,
    MD_TOC_KEY,
    MD_TOC_OMIT_KEY,
    ROOT,
} from '../../constants';
import { dim, green, red, replaceInBetween, slugify } from '../../helpers';
import type { Workspace } from '../../types';

type PluginMetadata = {
    title: string;
    intro: string;
    key: string;
    config: string;
};

const verifyReadmeExists = (pluginPath: string) => {
    const readmePath = path.resolve(ROOT, pluginPath, 'README.md');
    return fs.pathExistsSync(readmePath);
};

const getReadmeToc = (readmeContent: string) => {
    // Get all titles.
    const titles = readmeContent.match(/^#{1,3} (.*)/gm) || [];
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

            const finalTitle = restOfTitle.join(' ');
            const slug = slugify(finalTitle);

            return {
                name: finalTitle,
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
    const { CONFIG_KEY } = await require(path.resolve(ROOT, plugin.location, 'src/constants.ts'));
    // Load plugin's README.md file.
    const readmePath = path.resolve(ROOT, plugin.location, 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');

    // Get the title and the first paragraph.
    // Catch the first title and remove the `MD_TOC_OMIT_KEY` from it.
    const title = readme.match(/# (.*)/)?.[1].replace(` ${MD_TOC_OMIT_KEY}`, '') || '';
    // Catch the first line of text after the title.
    const intro = readme.match(/# .*\n\n(.*)/)?.[1] || '';
    // Catch the first block of code (```[...]```) right after the Configuration title.
    // Using [\s\S] to match any character including new lines.
    const config = readme.match(/## Configuration[\s\S]*?```[^\n\r]+\n([\s\S]*?)\n```/)?.[1] || '';
    const formattedConfig = config
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');

    return { title, intro, config: formattedConfig, key: CONFIG_KEY };
};

const getPluginTemplate = async (plugin: Workspace, pluginMeta: PluginMetadata) => {
    const { title, intro, key } = pluginMeta;
    return `### \`${key}\` ${title}\n\n> ${intro}\n\n<kbd>[📝 Full documentation ➡️](./${plugin.location}#readme)</kbd>`;
};

export const updateReadmes = async (plugins: Workspace[]) => {
    // Read the root README.md file.
    let rootReadmeContent = fs.readFileSync(path.resolve(ROOT, 'README.md'), 'utf-8');

    let pluginsList = '';
    let configuration = outdent`
    \`\`\`typescript
    {
        auth?: {
            apiKey?: string;
            endPoint?: string;
        };
        logLevel?: 'debug' | 'warn' | 'error' | 'none';
    `;
    const errors: string[] = [];
    const error = red('Error');

    await Promise.all(
        plugins.map(async (plugin, i) => {
            const readmePath = `${plugin.location}/README.md`;

            // Verify the plugin has a README.md file.
            if (!verifyReadmeExists(plugin.location)) {
                errors.push(`[${error}] ${green(plugin.name)} is missing "${dim(readmePath)}".`);
                return;
            }

            const readmeFullPath = path.resolve(ROOT, readmePath);
            const pluginMeta = await getPluginMetadata(plugin);
            const pluginTemplate = await getPluginTemplate(plugin, pluginMeta);

            if (!pluginMeta.title) {
                errors.push(
                    `[${error}] ${green(plugin.name)} is missing a title in "${dim(readmePath)}".`,
                );
            }

            if (!pluginMeta.intro) {
                errors.push(
                    `[${error}] ${green(plugin.name)} is missing an intro in "${dim(readmePath)}".`,
                );
            }

            if (!pluginMeta.config) {
                errors.push(
                    `[${error}] ${green(plugin.name)} is missing a configuration in "${dim(
                        readmePath,
                    )}".`,
                );
            }

            if (i > 0) {
                pluginsList += '\n\n';
                configuration += ';';
            }

            pluginsList += pluginTemplate;
            configuration += `\n${pluginMeta.config}`;

            // Update Table of content of plugin
            const pluginReadmeContent = fs.readFileSync(readmeFullPath, 'utf-8');
            const pluginReadmeToc = getReadmeToc(pluginReadmeContent);

            console.log(`  Write ${green(plugin.name)}'s ${green(readmePath)}.`);
            fs.writeFileSync(
                readmeFullPath,
                replaceInBetween(pluginReadmeContent, MD_TOC_KEY, pluginReadmeToc),
            );
        }),
    );

    configuration += '\n}\n```';

    rootReadmeContent = replaceInBetween(rootReadmeContent, MD_PLUGINS_KEY, pluginsList);
    rootReadmeContent = replaceInBetween(rootReadmeContent, MD_CONFIGURATION_KEY, configuration);
    rootReadmeContent = replaceInBetween(
        rootReadmeContent,
        MD_TOC_KEY,
        getReadmeToc(rootReadmeContent),
    );

    console.log(`  Write ${green('README.md')}.`);
    fs.writeFileSync(path.resolve(ROOT, 'README.md'), rootReadmeContent);

    return errors;
};
