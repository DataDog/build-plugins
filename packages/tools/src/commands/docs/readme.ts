import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';

import { MD_PLUGINS_KEY, MD_TOC_KEY, MD_TOC_OMIT_KEY, ROOT } from '../../constants';
import { green, red, replaceInBetween, slugify } from '../../helpers';
import type { Plugin } from '../../types';

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

const getPluginMetadata = async (plugin: Plugin) => {
    const { CONFIG_KEY } = await require(path.resolve(ROOT, plugin.location, 'src/constants.ts'));
    // Load plugin's README.md file.
    const readmePath = path.resolve(ROOT, plugin.location, 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');
    // Get the title and the first paragraph.
    const title = readme.match(/# (.*)/)?.[1].replace(` ${MD_TOC_OMIT_KEY}`, '') || '';
    const intro = readme.match(/# .*\n\n(.*)/)?.[1] || '';
    return { title, intro, key: CONFIG_KEY };
};

const getPluginTemplate = async (plugin: Plugin) => {
    const { title, intro, key } = await getPluginMetadata(plugin);
    return `### \`${key}\` [${title}](./${plugin.location}#readme)\n\n> ${intro}`;
};

export const updateReadmes = async (plugins: Plugin[], content: string) => {
    let rootReadmeContent = content;
    let pluginsList = '';
    const errors = [];
    const error = red('Error');

    for (const plugin of plugins) {
        const readmePath = `${plugin.location}/README.md`;
        const readmeFullPath = path.resolve(ROOT, readmePath);
        const pluginTemplate = await getPluginTemplate(plugin);

        pluginsList += pluginTemplate;

        // Verify the plugin has a README.md file.
        if (!verifyReadmeExists(plugin.location)) {
            errors.push(`[${error}] ${green(plugin.name)} is missing "${chalk.dim(readmePath)}".`);
        } else {
            // Update Table of content of plugin
            const pluginReadmeContent = fs.readFileSync(readmeFullPath, 'utf-8');
            const pluginReadmeToc = getReadmeToc(pluginReadmeContent);
            fs.writeFileSync(
                readmeFullPath,
                replaceInBetween(pluginReadmeContent, MD_TOC_KEY, pluginReadmeToc),
            );
        }
    }

    rootReadmeContent = replaceInBetween(rootReadmeContent, MD_PLUGINS_KEY, pluginsList);
    rootReadmeContent = replaceInBetween(
        rootReadmeContent,
        MD_TOC_KEY,
        getReadmeToc(rootReadmeContent),
    );
    fs.writeFileSync(path.resolve(ROOT, 'README.md'), rootReadmeContent);

    return errors;
};
