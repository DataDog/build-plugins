// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

const { execFile } = require(`child_process`);
const { promisify } = require(`util`);
const { Command } = require(`clipanion`);
const fs = require('fs-extra');
const inquirer = require('inquirer');
const path = require('path');
const glob = require('glob');
const chalk = require('chalk');

const templates = require('./templates');

const execFileP = promisify(execFile);
const maxBuffer = 1024 * 1024;

const execute = (cmd, args, cwd) => execFileP(cmd, args, { maxBuffer, cwd, encoding: 'utf-8' });

const NAME = 'build-plugin';
const ROOT = process.env.PROJECT_CWD;

// Usually for arch/platform specific dependencies.
const DEPENDENCY_ADDITIONS = {
    // This one is only installed locally.
    '@rollup/rollup-darwin-arm64': {
        licenseName: 'MIT',
        libraryName: '@rollup/rollup-darwin-arm64',
        origin: 'npm',
        owner: 'Lukas Taegert-Atkinson',
        url: 'https://rollupjs.org/',
    },
    '@esbuild/darwin-arm64': {
        licenseName: 'MIT',
        libraryName: '@esbuild/darwin-arm64',
        origin: 'npm',
    },
};
const DEPENDENCY_EXCEPTIONS = [];

if (!ROOT) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}

const IGNORED_FOLDERS = ['node_modules', '.git'];

class OSS extends Command {
    name = 'build-plugin';
    getFolders(filePath) {
        return fs
            .readdirSync(filePath, { withFileTypes: true })
            .filter((f) => f.isDirectory() && !IGNORED_FOLDERS.includes(f.name))
            .map((f) => f.name)
            .sort();
    }

    chooseFolder(folderPath, select = false) {
        const folders = this.getFolders(folderPath);
        const name = select ? 'folders' : 'folder';
        return inquirer.prompt([
            {
                type: select ? 'checkbox' : 'list',
                name,
                message: `Which ${name} do you want to make open source?`,
                choices: folders,
            },
        ]);
    }

    async replaceFiles(folderPath, subfolders, license) {
        const fileTypes = ['ts', 'tsx', 'js', 'jsx'];
        const files = glob.sync(
            `${folderPath}/@(${subfolders.join('|')})/**/*.@(${fileTypes.join('|')})`,
        );

        for (const file of files) {
            const fileName = chalk.green.bold(file.replace(ROOT, ''));
            try {
                // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
                const content = await fs.readFile(file, { encoding: 'utf8' });
                await fs.writeFile(
                    file,
                    `${templates.header(license.name)}\n${content.replace(templates.headerRX, '')}`,
                );
                this.context.stdout.write(`Processed ${fileName}.\n`);
            } catch (e) {
                this.context.stderr.write(e.toString());
            }
        }
    }

    async getDirectories() {
        return this.directories || (await this.chooseFolder(ROOT, true)).folders;
    }

    async getLicense() {
        const license =
            this.license ||
            (
                await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'license',
                        message: `Which license do you want to use?`,
                        choices: Object.keys(templates.licenses),
                    },
                ])
            ).license;
        return templates.licenses[license];
    }

    async applyHeader() {
        const subfolders = await this.getDirectories();
        const license = await this.getLicense();
        await this.replaceFiles(ROOT, subfolders, license);
    }

    async apply3rdPartiesLicenses() {
        let stdout;
        try {
            stdout = (await execute('yarn', ['licenses', 'list', '-R', '--json'], ROOT)).stdout;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.log(e);
        }

        const licenses = new Map();

        // Names in the output of `yarn licenses` will have the shape for instance of:
        // my-library@npm:1.2.3 or @my-org/my-library@npm:1.2.3
        // So we want to extract the name (either `my-library` or `@my-org/my-library`),
        // and the provider (here `npm`), but not the version
        const nameRegex = /^(@.*?\/.*?|[^@]+)@(.+?):(.+?)$/;
        const errors = [];
        for (const licenseObject of stdout
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))) {
            const licenseName = licenseObject.value;
            for (const [libraryWithVersion, infos] of Object.entries(licenseObject.children)) {
                const match = libraryWithVersion.match(nameRegex);
                if (!match) {
                    continue;
                }
                const [, libraryName, origin, rest] = match;

                if (DEPENDENCY_EXCEPTIONS.some((exception) => libraryName.match(exception))) {
                    console.log(`  [Note] Skipping ${libraryName} as it is an exception.`);
                    continue;
                }

                // Sometimes, the library name has the platform and arch in it.
                // We should list them all.
                if (libraryName.match(/(darwin|linux)-(x64|arm64)/)) {
                    console.log(`  [Note] ${libraryName} carries the platform or arch.`);
                    const dependencyObj = {
                        licenseName,
                        libraryName,
                        origin,
                        owner: infos.children.vendorName,
                        url: infos.children.vendorUrl,
                    };
                    const objLog = `\n'${libraryName}': ${JSON.stringify(dependencyObj, null, 4)},\n`;
                    // Verify the local DEPENDENCY_ADDITIONS has the same infos.
                    if (Object.keys(DEPENDENCY_ADDITIONS).includes(libraryName)) {
                        if (
                            JSON.stringify(DEPENDENCY_ADDITIONS[libraryName]) !==
                            JSON.stringify(dependencyObj)
                        ) {
                            console.log(`   - different from DEPENDENCY_ADDITIONS.`);
                            errors.push(`Update ${libraryName} to DEPENDENCY_ADDITIONS.`);
                        } else {
                            console.log(`   - already in DEPENDENCY_ADDITIONS.`);
                        }
                    } else {
                        console.log(`   - should be added in DEPENDENCY_ADDITIONS.`);
                        errors.push(`Add ${libraryName} to DEPENDENCY_ADDITIONS.\n${objLog}`);
                    }
                }

                if (licenses.has(libraryName)) {
                    continue;
                }

                // Native patches injected by yarn. Not in our node modules
                if (origin === 'patch' && rest.includes('builtin<')) {
                    continue;
                }

                licenses.set(libraryName, {
                    licenseName,
                    libraryName,
                    origin,
                    owner: infos.children.vendorName,
                    url: infos.children.vendorUrl,
                });
            }

            if (errors.length) {
                console.log(`\n${errors.join('\n')}`);
                throw new Error('Please fix the errors above.');
            }

            let content = `Component,Origin,Licence,Copyright`;

            for (const license of [...licenses.values()].sort((a, b) =>
                a.libraryName.localeCompare(b.libraryName),
            )) {
                content += `\n${license.libraryName},${license.origin},${license.licenseName},`;
                if (license.owner) {
                    content += license.owner.replaceAll('"', '').replaceAll(',', ' ');
                }
                if (license.owner && license.url) {
                    content += ' ';
                }
                if (license.url) {
                    content += `(${license.url})`;
                }
            }

            fs.writeFileSync(path.join(ROOT, 'LICENSES-3rdparty.csv'), content);
        }
    }

    async applyNotice() {
        await fs.writeFile(path.join(ROOT, 'NOTICE'), templates.notice(NAME));
    }

    async applyLicense() {
        const license = await this.getLicense();
        const readmePath = path.join(ROOT, 'README.md');
        const licensePath = path.join(ROOT, 'LICENSE');

        // Update LICENSE
        await fs.writeFile(licensePath, license.content);

        // Update README
        // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
        const readmeContent = await fs.readFile(readmePath, { encoding: 'utf8' });
        const newContent = readmeContent.replace(
            /(^\[)[^](]+\]\(LICENSE\)$)/gm,
            `$1${license.name}$2`,
        );
        await fs.writeFile(readmePath, newContent);
    }

    async execute() {
        await this.applyHeader();
        this.context.stdout.write('Done header.\n');
        await this.apply3rdPartiesLicenses();
        this.context.stdout.write('Done 3rd parties licenses.\n');
        await this.applyNotice();
        this.context.stdout.write('Done notice.\n');
        await this.applyLicense();
        this.context.stdout.write('Done license.\n');
    }
}

OSS.addPath(`oss`);
OSS.addOption(
    `license`,
    Command.String(`-l,--license`, {
        description: 'Which license do you want? [mit, apache, bsd]',
    }),
);
OSS.addOption(
    `directories`,
    Command.Array(`-d,--directories`, {
        description: 'On which directories to add the Open Source header?',
    }),
);

module.exports = [OSS];
