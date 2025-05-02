// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import checkbox from '@inquirer/checkbox';
import select from '@inquirer/select';
import chalk from 'chalk';
import fs from 'fs';
import { glob } from 'glob';
import path from 'path';

import { NAME, ROOT } from '../../constants';
import { blue, bold, execute, green } from '../../helpers';

import * as templates from './templates';

const fsp = fs.promises;

const LICENSES_FILE = path.join(ROOT, 'LICENSES-3rdparty.csv');

const IGNORED_FOLDERS = ['node_modules', '.git', 'dist'];

type License = {
    licenseName: string;
    libraryName: string;
    origin: string;
    owner: string;
};

// Usually for arch/platform specific dependencies.
const DEPENDENCY_ADDITIONS: Record<string, License> = {
    // This one is only installed locally.
    '@esbuild/darwin-arm64': {
        licenseName: 'MIT',
        libraryName: '@esbuild/darwin-arm64',
        origin: 'npm',
        owner: '(https://www.npmjs.com/package/@esbuild/darwin-arm64)',
    },
    // This one is only installed locally.
    '@esbuild/darwin-x64': {
        licenseName: 'MIT',
        libraryName: '@esbuild/darwin-x64',
        origin: 'npm',
        owner: '(https://www.npmjs.com/package/@esbuild/darwin-x64)',
    },
    // This one is only installed in the CI.
    '@esbuild/linux-x64': {
        licenseName: 'MIT',
        libraryName: '@esbuild/linux-x64',
        origin: 'npm',
        owner: '(https://www.npmjs.com/package/@esbuild/linux-x64)',
    },
    // This one is only installed locally.
    '@rollup/rollup-darwin-arm64': {
        licenseName: 'MIT',
        libraryName: '@rollup/rollup-darwin-arm64',
        origin: 'npm',
        owner: 'Lukas Taegert-Atkinson (https://rollupjs.org/)',
    },
    // This one is only installed locally.
    '@rollup/rollup-darwin-x64': {
        licenseName: 'MIT',
        libraryName: '@rollup/rollup-darwin-x64',
        origin: 'npm',
        owner: 'Lukas Taegert-Atkinson (https://rollupjs.org/)',
    },
    // This one is only installed locally.
    '@rspack/binding-darwin-arm64': {
        licenseName: 'MIT',
        libraryName: '@rspack/binding-darwin-arm64',
        origin: 'npm',
        owner: '(https://rspack.dev)',
    },
    // This one is only installed locally.
    '@rspack/binding-darwin-x64': {
        licenseName: 'MIT',
        libraryName: '@rspack/binding-darwin-x64',
        origin: 'npm',
        owner: '(https://rspack.dev)',
    },
};

const DEPENDENCY_EXCEPTIONS: string[] = [];

const getFolders = (filePath: string) => {
    return fs
        .readdirSync(filePath, { withFileTypes: true })
        .filter((f) => f.isDirectory() && !IGNORED_FOLDERS.includes(f.name))
        .map((f) => f.name)
        .sort()
        .map((f) => ({ name: f, value: f }));
};

const chooseFolder = (folderPath: string) => {
    const folders = getFolders(folderPath);
    return checkbox({
        message: `Which folders do you want to make open source?`,
        choices: folders,
    });
};

const replaceFiles = async (
    folderPath: string,
    subfolders: string[],
    license: templates.LicenseTemplate,
) => {
    const fileTypes = ['ts', 'tsx', 'js', 'jsx', 'mjs'];
    const files = glob
        .sync(`${folderPath}/@(${subfolders.join('|')})/**/*.@(${fileTypes.join('|')})`)
        // Filter out node_modules
        .filter((file) => !file.includes('node_modules'));

    for (const file of files) {
        const fileName = green(file.replace(ROOT, ''));
        try {
            // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
            const content = await fsp.readFile(file, { encoding: 'utf8' });
            await fsp.writeFile(
                file,
                `${templates.header(license.name)}\n${content.replace(templates.headerRX, '')}`,
            );
            console.log(`Processed ${fileName}.`);
        } catch (e) {
            console.error(e);
        }
    }
};

const getDirectories = async (directories?: string[]) => {
    return directories || chooseFolder(ROOT);
};

const getLicense = async (licenseInput?: string) => {
    const license =
        licenseInput ||
        (await select({
            message: `Which license do you want to use?`,
            choices: Object.keys(templates.licenses).map((l) => ({
                name: l,
                value: l,
            })),
        }));

    return templates.licenses[license];
};

const getExistingLicenses = () => {
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
};

const areSameLicense = (a: License, b: License) => {
    let areTheSame = true;
    const keys = ['libraryName', 'origin', 'licenseName', 'owner'] as const;
    for (const key of keys) {
        if (a[key] && b[key] && a[key] !== b[key]) {
            console.log(
                `    - Different ${green(a.libraryName)} on "${bold(key)}" => ${bold(a[key])} vs ${bold(b[key])}`,
            );
            areTheSame = false;
            break;
        }
    }
    return areTheSame;
};

const createOwnerString = ({
    name,
    owner,
    url,
}: {
    name: string;
    owner?: string;
    url?: string;
}) => {
    let ownerString = '';
    if (owner) {
        ownerString += owner.replaceAll('"', '').replaceAll(',', ' ');
    }
    if (owner) {
        ownerString += ' ';
    }

    ownerString += `(${url || `https://www.npmjs.com/package/${name}`})`;

    return ownerString;
};

export const applyHeader = async (directories?: string[], licenseInput?: string) => {
    const subfolders = await getDirectories(directories);
    const license = await getLicense(licenseInput);
    await replaceFiles(ROOT, subfolders, license);
};

export const apply3rdPartiesLicenses = async () => {
    let stdout = '';
    try {
        stdout = (await execute('yarn', ['licenses', 'list', '-R', '--json'])).stdout;
    } catch (e) {
        console.log(e);
    }

    const workspaces = (await execute('yarn', ['workspaces', 'list', '--json'])).stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).name);

    const existingLicenses = getExistingLicenses();
    const licenses = new Map();
    const error = blue('Update');
    const note = chalk.grey('Note');
    const printAdd = bold('DEPENDENCY_ADDITIONS');

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
            const printName = green(libraryName);
            const libInfos = {
                licenseName,
                libraryName,
                origin,
                owner: createOwnerString({
                    name: libraryName,
                    owner: vendorName,
                    url: vendorUrl,
                }),
            };

            if (DEPENDENCY_EXCEPTIONS.some((exception) => libraryName.match(exception))) {
                console.log(`  [${note}] Skipping ${printName} as it is an exception.`);
                continue;
            }

            // Sometimes, the library name has the platform and arch in it.
            // We should be made aware of it.
            if (libraryName.match(/(darwin|linux)-(x64|arm64)/)) {
                console.log(`  [${note}] ${printName} carries the platform and/or arch.`);
            }

            if (licenses.has(libraryName)) {
                continue;
            }

            // Native patches injected by yarn. Not in our node modules
            if (origin === 'patch' && rest.includes('builtin<')) {
                continue;
            }

            // We ignore workspaces dependencies.
            if (workspaces.includes(libraryName)) {
                continue;
            }

            // Verify the integrity of the local DEPENDENCY_ADDITIONS.
            if (Object.keys(DEPENDENCY_ADDITIONS).includes(libraryName)) {
                console.log(`  [${note}] ${printName} is in ${printAdd}.`);
                if (!areSameLicense(DEPENDENCY_ADDITIONS[libraryName], libInfos)) {
                    console.log(`     - different from DEPENDENCY_ADDITIONS.`);
                    errors.push(`[${error}] Updated ${printName} to ${printAdd}.`);
                }
            }

            // Verify the integraty of existing licenses.
            if (!existingLicenses.has(libraryName)) {
                console.log(`  [${note}] ${printName} will be added.`);
                errors.push(`[${error}] Added ${printName} to the existing licenses.`);
            } else {
                const existing = existingLicenses.get(libraryName);
                if (!areSameLicense(existing, libInfos)) {
                    console.log(`  [${note}] ${printName} has changed.`);
                    errors.push(`[${error}] Updated ${printName} in the existing licenses.`);
                }
            }

            licenses.set(libraryName, libInfos);
        }
    }

    // Adding DEPENDENCY_ADDITIONS
    for (const [libraryName, infos] of Object.entries(DEPENDENCY_ADDITIONS)) {
        if (!licenses.has(libraryName)) {
            console.log(`  [${note}] Adding ${green(libraryName)} from ${printAdd}.`);
            licenses.set(libraryName, infos);
        }
    }

    // Verify we're not missing dependencies from the existing ones.
    for (const [libraryName] of existingLicenses) {
        if (!licenses.has(libraryName)) {
            console.log(`  [${note}] ${green(libraryName)} is not needed anymore.`);
            errors.push(`[${error}] Removed ${green(libraryName)} from the existing licenses.`);
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
    }
};

export const applyNotice = async () => {
    await fsp.writeFile(path.join(ROOT, 'NOTICE'), templates.notice(NAME));
};

export const applyLicense = async (licenseInput?: string) => {
    const license = await getLicense(licenseInput);
    const readmePath = path.join(ROOT, 'README.md');
    const licensePath = path.join(ROOT, 'LICENSE');

    // Update LICENSE
    await fsp.writeFile(licensePath, license.content);

    // Update README
    // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
    const readmeContent = await fsp.readFile(readmePath, { encoding: 'utf8' });
    const newContent = readmeContent.replace(/(^\[)[^](]+\]\(LICENSE\)$)/gm, `$1${license.name}$2`);
    await fsp.writeFile(readmePath, newContent);
};
