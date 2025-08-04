// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    INTERNAL_PLUGINS_LIST,
    MD_BUNDLERS_KEY,
    MD_CONFIGURATION_KEY,
    MD_GLOBAL_CONTEXT_KEY,
    MD_HOOKS_KEY,
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
    hooks: string;
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

const README_EXCEPTIONS = [
    // We decided to not publicly communicate about the rum-plugin yet.
    // But we keep its sources in so it can be tested internally
    // and evolve with the rest of the ecosystem.
    '@dd/rum-plugin',
];

const error = red('Error|README');
// Matches image tags individually with surrounding whitespaces.
const IMG_RX = /[\s]*<img.+?(?=\/>)\/>[\s]*/g;
// Matches markdown links individually and catch targets.
const MARKDOWN_LINK_RX = /\[[^\]]+\]\(([^)]+)\)/g;

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
        // Get the hooks content.
        // We only want the content between the Hooks title and the next title.
        // Each hook should have a deeper level than ##.
        hooks:
            // We're excluding the internal custom hooks plugin,
            // in order to avoid catching its own documentation examples.
            plugin.name === '@dd/internal-custom-hooks-plugin'
                ? ''
                : readme.match(/^#{1,2} Hooks.*\s*(([\s\S](?!^#{1,2} ))*)/m)?.[1].trim() || '',
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
    // And for lines that are empty, end them with a `<br/>` to avoid auto format discreptancies.
    const quotedIntro = intro.replace(/^(> |)/gm, '> ').replace(/^> $/gm, '> <br/>');

    return outdent`
        ${titleContent}${bundlerContent ? ` ${bundlerContent}` : ''}

        ${quotedIntro}

        #### [📝 Full documentation ➡️](/${plugin.location}#readme)
        ${configContent}
    `;
};

const getPluginHooks = (plugin: Workspace, pluginMeta: PluginMetadata) => {
    const { hooks } = pluginMeta;
    // Re-level all the titles.
    const reLeveledContent = hooks.replace(/^#+ /gm, '#### ');
    const title = `### ${pluginMeta.title}`;
    const linkToDoc = `> [📝 Full documentation ➡️](/${plugin.location}#hooks)`;
    return hooks ? `${title}\n\n${linkToDoc}\n\n${reLeveledContent}\n` : '';
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

const handleBundler = (bundler: Workspace) => {
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

        console.log(`  Inject ${green('TOC')} in ${green(path.relative(ROOT, readmePath))}.`);
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
    const hooks = getPluginHooks(plugin, pluginMeta);

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
        hooks,
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
    const hooksReadmePath = path.resolve(ROOT, './packages/plugins/custom-hooks/README.md');
    const factoryReadmePath = path.resolve(ROOT, './packages/factory/README.md');

    // Read the README.md files.
    let rootReadmeContent = fs.readFileSync(rootReadmePath, 'utf-8');
    let hooksReadmeContent = fs.readFileSync(hooksReadmePath, 'utf-8');
    let factoryReadmeContent = fs.readFileSync(factoryReadmePath, 'utf-8');

    const pluginsContents: string[] = [];
    const internalPluginsContents: string[] = [];
    const bundlersContents: string[] = [];
    const hooksContents: string[] = [];
    const configContents: string[] = [
        outdent`
            \`\`\`typescript
            {
                auth?: {
                    apiKey?: string;
                    appKey?: string;
                };
                customPlugins?: (arg: GetPluginsArg) => UnpluginPlugin[];
                enableGit?: boolean;
                logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none',
                metadata?: {
                    name?: string;
                };
        `,
    ];
    const errors: string[] = [];

    for (const plugin of plugins) {
        if (README_EXCEPTIONS.includes(plugin.name)) {
            continue;
        }

        const { list, hooks, config, internal, errors: pluginErrors } = await handlePlugin(plugin);
        if (hooks) {
            hooksContents.push(hooks);
        }
        if (!internal) {
            pluginsContents.push(list);
            configContents.push(config);
        } else {
            internalPluginsContents.push(list);
        }
        errors.push(...pluginErrors);
    }

    for (const bundler of bundlers) {
        const { list, errors: bundlerErrors } = handleBundler(bundler);
        bundlersContents.push(list);
        errors.push(...bundlerErrors);
    }

    configContents.push('}\n```');

    rootReadmeContent = replaceInBetween(
        rootReadmeContent,
        MD_PLUGINS_KEY,
        pluginsContents.join('\n\n'),
    );
    hooksReadmeContent = replaceInBetween(
        hooksReadmeContent,
        MD_HOOKS_KEY,
        hooksContents.join('\n'),
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
        `  Inject ${green('configurations')}, ${green('plugins list')} and ${green('hooks list')} into the ${green('READMEs')}.`,
    );
    fs.writeFileSync(rootReadmePath, rootReadmeContent);
    fs.writeFileSync(factoryReadmePath, factoryReadmeContent);
    fs.writeFileSync(hooksReadmePath, hooksReadmeContent);

    return errors;
};

const isInternalLinkValid = (target: string, currentFilepath: string, rootDir: string): boolean => {
    // We don't validate external links
    if (/^https?:\/\//.test(target)) {
        return true;
    }

    // Split path and anchor
    const [targetPath, anchor] = target.includes('#') ? target.split('#') : [target, null];

    // If the target starts with "/", we resolve it against the root directory.
    // If it starts with "#", we assume it's an anchor in the current file.
    // Otherwise, we resolve it against the directory of the current file.
    let resolvedPath = targetPath.startsWith('/')
        ? // Using path.join to avoid using targetPath as the root.
          path.join(rootDir, targetPath)
        : // If the target is an anchor, we remain in the same file.
          target.startsWith('#')
          ? currentFilepath
          : path.resolve(path.dirname(currentFilepath), targetPath);

    // If we target an anchor and the target is a directory, we assume there's a README.md file.
    if (anchor && fs.statSync(resolvedPath).isDirectory()) {
        resolvedPath = path.join(resolvedPath, 'README.md');
    }

    // Check if the file exists
    if (!fs.existsSync(resolvedPath)) {
        return false;
    }

    // If there's an anchor, verify it exists in the target file
    if (anchor) {
        // Get the linked file's content.
        const linkedFileContent = fs.readFileSync(resolvedPath, 'utf-8');
        // List all its slugs.
        const slugs =
            linkedFileContent
                // Remove code blocks to avoid non-header # usage.
                .replace(/```[\s\S]*?```/gm, '')
                // Match headings (starting with #).
                .match(/^#+ .+$/gm)
                // Convert everything to clean slugs.
                ?.map((heading) =>
                    slugify(heading.replace(/^#+ */, '').trim().replace(IMG_RX, '-').toLowerCase()),
                ) || [];

        // Include 'readme' and 'top' as a valid anchor for the top of the file.
        slugs.push('readme', 'top');

        return slugs.includes(anchor.toLowerCase());
    }

    return true;
};

export const verifyLinks = async (): Promise<string[]> => {
    const errors: string[] = [];

    // Get all markdown files
    const files = glob.sync('**/*.md', {
        ignore: ['**/node_modules/**', '.yarn/**'],
        absolute: true,
        cwd: ROOT,
    });

    console.log(
        `  Verifying ${green('markdown links')} in ${green(files.length.toString())} file${files.length <= 1 ? '' : 's'}.`,
    );

    for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            // Reset regex
            MARKDOWN_LINK_RX.lastIndex = 0;
            let match = MARKDOWN_LINK_RX.exec(line);
            while (match !== null) {
                const target = match[1].trim();
                // Skip external links (http/https)
                if (!isInternalLinkValid(target, file, ROOT)) {
                    // Report broken links
                    errors.push(
                        `[${error}] ${path.relative(ROOT, file)}:${lineNum + 1} - Broken link: ${dim(target)}`,
                    );
                }
                match = MARKDOWN_LINK_RX.exec(line);
            }
        }
    }

    return errors;
};
