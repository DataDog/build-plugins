// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import chalk from 'chalk';
import { Command } from 'clipanion';
import fs from 'fs-extra';
import path from 'path';

import { ROOT, execute, green, red, replaceInBetween, slugify } from '../../helpers';
import { MD_TOC_OMIT_KEY, MD_PLUGINS_KEY, MD_TOC_KEY } from '../create-plugin/templates';

type Plugin = {
    name: string;
    location: string;
};

class Docs extends Command {
    static paths = [['docs']];

    static usage = Command.Usage({
        category: `Verification`,
        description: `Verify our documentation and update it.`,
        details: `
            This command will update our documentation to include all our plugins.
        `,
        examples: [[`Update documentation`, `$0 docs`]],
    });

    async getPlugins() {
        const { stdout: rawPlugins } = await execute('yarn', ['workspaces', 'list', '--json']);
        // Replace new lines with commas to make it JSON valid.
        const jsonString = `[${rawPlugins.replace(/\n([^\]])/g, ',\n$1')}]`;
        const pluginsArray = JSON.parse(jsonString) as Plugin[];
        return pluginsArray.filter((plugin: Plugin) =>
            plugin.location.startsWith('packages/plugins'),
        );
    }

    verifyReadmeExists(pluginPath: string) {
        const readmePath = path.resolve(ROOT, pluginPath, 'README.md');
        return fs.pathExistsSync(readmePath);
    }

    async getPluginMetadata(plugin: Plugin) {
        const { CONFIG_KEY } = await require(
            path.resolve(ROOT, plugin.location, 'src/constants.ts'),
        );
        // Load plugin's README.md file.
        const readmePath = path.resolve(ROOT, plugin.location, 'README.md');
        const readme = fs.readFileSync(readmePath, 'utf-8');
        // Get the title and the first paragraph.
        const title = readme.match(/# (.*)/)?.[1].replace(` ${MD_TOC_OMIT_KEY}`, '') || '';
        const intro = readme.match(/# .*\n\n(.*)/)?.[1] || '';
        return { title, intro, key: CONFIG_KEY };
    }

    async getPluginTemplate(plugin: Plugin) {
        const { title, intro, key } = await this.getPluginMetadata(plugin);
        return `### \`${key}\` [${title}](./${plugin.location}#readme)\n\n> ${intro}`;
    }

    getReadmeToc(readmeContent: string) {
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
    }

    async execute() {
        // Read the root README.md file.
        let rootReadmeContent = fs.readFileSync(path.resolve(ROOT, 'README.md'), 'utf-8');

        // Load all the plugins' README.md files.
        const plugins = await this.getPlugins();

        const errors = [];
        const error = red('Error');

        let pluginsList = '';

        for (const plugin of plugins) {
            const readmePath = `${plugin.location}/README.md`;
            const readmeFullPath = path.resolve(ROOT, readmePath);
            const pluginTemplate = await this.getPluginTemplate(plugin);

            pluginsList += pluginTemplate;

            // Verify the plugin has a README.md file.
            if (!this.verifyReadmeExists(plugin.location)) {
                errors.push(
                    `[${error}] ${green(plugin.name)} is missing "${chalk.dim(readmePath)}".`,
                );
            } else {
                // Update Table of content of plugin
                const pluginReadmeContent = fs.readFileSync(readmeFullPath, 'utf-8');
                const pluginReadmeToc = this.getReadmeToc(pluginReadmeContent);
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
            this.getReadmeToc(rootReadmeContent),
        );
        fs.writeFileSync(path.resolve(ROOT, 'README.md'), rootReadmeContent);

        if (errors.length) {
            console.log(`\n${errors.join('\n')}`);
            throw new Error('Please fix the errors.');
        }
    }
}

export default [Docs];
