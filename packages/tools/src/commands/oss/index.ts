// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

import chalk from 'chalk';
import { execFile } from 'child_process';
import { Command, Option } from 'clipanion';
import fs from 'fs-extra';
import glob from 'glob';
import inquirer from 'inquirer';
import path from 'path';
import { promisify } from 'util';

import * as templates from './templates';

const execFileP = promisify(execFile);
const maxBuffer = 1024 * 1024;

const execute = (cmd: string, args: string[], cwd: string) =>
    execFileP(cmd, args, { maxBuffer, cwd, encoding: 'utf-8' });

const NAME = 'build-plugin';

if (!process.env.PROJECT_CWD) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}
const ROOT = process.env.PROJECT_CWD!;

const LICENSES_FILE = path.join(ROOT, 'LICENSES-3rdparty.csv');

type License = {
    licenseName: string;
    libraryName: string;
    origin: string;
    owner: string;
};

// Usually for arch/platform specific dependencies.
const DEPENDENCY_ADDITIONS: Record<string, License> = {
    // This one is only installed locally.
    '@rollup/rollup-darwin-arm64': {
        licenseName: 'MIT',
        libraryName: '@rollup/rollup-darwin-arm64',
        origin: 'npm',
        owner: 'Lukas Taegert-Atkinson (https://rollupjs.org/)',
    },
    // This one is only installed locally.
    '@esbuild/darwin-arm64': {
        licenseName: 'MIT',
        libraryName: '@esbuild/darwin-arm64',
        origin: 'npm',
        owner: '',
    },
    // This one is only installed in the CI.
    '@esbuild/linux-x64': {
        licenseName: 'MIT',
        libraryName: '@esbuild/linux-x64',
        origin: 'npm',
        owner: '',
    },
};

const DEPENDENCY_EXCEPTIONS: string[] = [];

if (!ROOT) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}

const IGNORED_FOLDERS = ['node_modules', '.git'];

class OSS extends Command {
    static paths = [['oss']];

    license = Option.String(`-l,--license`, {
        description: 'Which license do you want? [mit, apache, bsd]',
    });
    directories = Option.Array(`-d,--directories`, {
        description: 'On which directories to add the Open Source header?',
    });
    name = 'build-plugin';

    getFolders(filePath: string) {
        return fs
            .readdirSync(filePath, { withFileTypes: true })
            .filter((f) => f.isDirectory() && !IGNORED_FOLDERS.includes(f.name))
            .map((f) => f.name)
            .sort();
    }

    chooseFolder(folderPath: string, select = false) {
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

    async replaceFiles(
        folderPath: string,
        subfolders: string[],
        license: templates.LicenseTemplate,
    ) {
        const fileTypes = ['ts', 'tsx', 'js', 'jsx', 'mjs'];
        const files = glob
            .sync(`${folderPath}/@(${subfolders.join('|')})/**/*.@(${fileTypes.join('|')})`)
            // Filter out node_modules
            .filter((file) => !file.includes('node_modules'));

        for (const file of files) {
            const fileName = chalk.green.bold(file.replace(ROOT, ''));
            try {
                // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
                const content = await fs.readFile(file, { encoding: 'utf8' });
                await fs.writeFile(
                    file,
                    `${templates.header(license.name)}\n${content.replace(templates.headerRX, '')}`,
                );
                console.log(`Processed ${fileName}.`);
            } catch (e) {
                console.error(e);
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

    getExistingLicenses() {
        const licenses = new Map();
        const fileContent = fs.readFileSync(LICENSES_FILE, { encoding: 'utf8' });
        const lines = fileContent.split('\n');
        const clean = (str: string) => str || '';

        for (const line of lines.slice(1)) {
            if (!line) {
                continue;
            }
            const [libraryName, origin, licenseName, owner] = line.split(',');
            licenses.set(libraryName, {
                libraryName: clean(libraryName),
                origin: clean(origin),
                licenseName: clean(licenseName),
                owner: clean(owner),
            });
        }

        return licenses;
    }

    areSameLicense(a: License, b: License) {
        let areTheSame = true;
        const keys = ['libraryName', 'origin', 'licenseName', 'owner'] as const;
        for (const key of keys) {
            if (a[key] && b[key] && a[key] !== b[key]) {
                console.log('Different:', a.libraryName, key, a[key], b[key]);
                areTheSame = false;
                break;
            }
        }
        return areTheSame;
    }

    createOwnerString({ owner, url }: { owner?: string; url?: string }) {
        let ownerString = '';
        if (owner) {
            ownerString += owner.replaceAll('"', '').replaceAll(',', ' ');
        }
        if (owner && url) {
            ownerString += ' ';
        }
        if (url) {
            ownerString += `(${url})`;
        }

        return ownerString;
    }

    async apply3rdPartiesLicenses() {
        let stdout = '';
        try {
            stdout = (await execute('yarn', ['licenses', 'list', '-R', '--json'], ROOT)).stdout;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.log(e);
        }

        const existingLicenses = this.getExistingLicenses();
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
                const { vendorName, vendorUrl } = (infos as any).children;
                const [, libraryName, origin, rest] = match;
                const libInfos = {
                    licenseName,
                    libraryName,
                    origin,
                    owner: this.createOwnerString({
                        owner: vendorName,
                        url: vendorUrl,
                    }),
                };

                if (DEPENDENCY_EXCEPTIONS.some((exception) => libraryName.match(exception))) {
                    console.log(`  [Note] Skipping ${libraryName} as it is an exception.`);
                    continue;
                }

                // Sometimes, the library name has the platform and arch in it.
                // We should be made aware of it.
                if (libraryName.match(/(darwin|linux)-(x64|arm64)/)) {
                    console.log(`  [Note] ${libraryName} carries the platform and/or arch.`);
                }

                if (licenses.has(libraryName)) {
                    continue;
                }

                // Native patches injected by yarn. Not in our node modules
                if (origin === 'patch' && rest.includes('builtin<')) {
                    continue;
                }

                // Verify the integrity of the local DEPENDENCY_ADDITIONS.
                if (Object.keys(DEPENDENCY_ADDITIONS).includes(libraryName)) {
                    console.log(`  [Note] ${libraryName} is in DEPENDENCY_ADDITIONS.`);
                    if (!this.areSameLicense(DEPENDENCY_ADDITIONS[libraryName], libInfos)) {
                        console.log(`     - different from DEPENDENCY_ADDITIONS.`);
                        errors.push(`[Error] Updated ${libraryName} to DEPENDENCY_ADDITIONS.`);
                    }
                }

                // Verify the integraty of existing licenses.
                if (!existingLicenses.has(libraryName)) {
                    console.log(`  [Note] ${libraryName} will be added.`);
                    errors.push(`[Error] Added ${libraryName} to the existing licenses.`);
                } else {
                    const existing = existingLicenses.get(libraryName);
                    if (!this.areSameLicense(existing, libInfos)) {
                        console.log(`  [Note] ${libraryName} has changed.`);
                        errors.push(`[Error] Updated ${libraryName} in the existing licenses.`);
                    }
                }

                licenses.set(libraryName, libInfos);
            }
        }

        // Adding DEPENDENCY_ADDITIONS
        for (const [libraryName, infos] of Object.entries(DEPENDENCY_ADDITIONS)) {
            if (!licenses.has(libraryName)) {
                console.log(`  [Note] Adding ${libraryName} from DEPENDENCY_ADDITIONS.`);
                licenses.set(libraryName, infos);
            }
        }

        // Verify we're not missing dependencies from the existing ones.
        for (const [libraryName] of existingLicenses) {
            if (!licenses.has(libraryName)) {
                console.log(`  [Note] ${libraryName} is missing.`);
                errors.push(`[Error] Missed ${libraryName} from the existing licenses.`);
            }
        }

        let content = `Component,Origin,Licence,Copyright`;

        for (const license of [...licenses.values()].sort((a, b) =>
            a.libraryName.localeCompare(b.libraryName),
        )) {
            content += `\n${license.libraryName},${license.origin},${license.licenseName},${license.owner}`;
        }

        fs.writeFileSync(LICENSES_FILE, content);

        if (errors.length) {
            console.log(`\n${errors.join('\n')}`);
            throw new Error('Please fix the errors above.');
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
        console.log('Done header.');
        await this.apply3rdPartiesLicenses();
        console.log('Done 3rd parties licenses.');
        await this.applyNotice();
        console.log('Done notice.');
        await this.applyLicense();
        console.log('Done license.');
    }
}

export default [OSS];
