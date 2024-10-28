// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ROOT } from '@dd/tools/constants';
import { dim, green, red } from '@dd/tools/helpers';
import type { Workspace } from '@dd/tools/types';
import fs from 'fs-extra';
import path from 'path';

type PackageJson = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

const jsonCache: Map<string, PackageJson> = new Map();

const getPackageJson = (workspace: Workspace) => {
    const pkg: PackageJson =
        jsonCache.get(workspace.name) ||
        fs.readJSONSync(path.resolve(ROOT, workspace.location, 'package.json'));
    jsonCache.set(workspace.name, pkg);

    return pkg;
};

// Some exceptions.
const dependencyExceptions = [
    // In the published packages, '@dd/tools' is listed in order to use the common rollup configuration.
    // We don't want, nor need, to list it as a dependency of the published package.
    '@dd/tools',
];

// Some filters.
const allDependencies = (dependencyName: string) => !dependencyExceptions.includes(dependencyName);
const onlyInternalDependencies = (dependencyName: string) =>
    dependencyName.startsWith('@dd/') && allDependencies(dependencyName);
const onlyExternalDependencies = (dependencyName: string) =>
    !dependencyName.startsWith('@dd/') && allDependencies(dependencyName);

// Clean a record of dependencies based on a given filter.
const cleanDependencies = (
    dependencies: Record<string, string> = {},
    filter:
        | typeof onlyInternalDependencies
        | typeof onlyExternalDependencies
        | typeof allDependencies,
) => {
    return Object.fromEntries(Object.entries(dependencies).filter(([dep]) => filter(dep)));
};

// From a workspace, recursively returns its internal dependencies.
const getInternalDependencies = (
    workspaces: Workspace[],
    workspace: Workspace,
    errors: string[] = [],
    dependencies: Set<string> = new Set(),
) => {
    const pkg: PackageJson = getPackageJson(workspace);

    const internalDependencies = new Set([
        ...(pkg.dependencies
            ? Object.keys(cleanDependencies(pkg.dependencies, onlyInternalDependencies))
            : []),
        ...(pkg.devDependencies
            ? Object.keys(cleanDependencies(pkg.devDependencies, onlyInternalDependencies))
            : []),
    ]);

    for (const dep of internalDependencies) {
        const depWorkspace = workspaces.find((w) => w.name === dep);
        if (!depWorkspace) {
            errors.push(`Could not find workspace for ${dep}.`);
            continue;
        }

        if (!dependencies.has(depWorkspace.name)) {
            dependencies.add(depWorkspace.name);
            getInternalDependencies(workspaces, depWorkspace, errors, dependencies);
        }
    }

    return { errors, dependencies };
};

// From a workspace name, returns its dependencies and their versions.
const getDependencies = (workspaces: Workspace[], name: string) => {
    const errors: string[] = [];
    const dependencies: Map<string, string> = new Map();

    const workspace = workspaces.find((w) => w.name === name);
    if (!workspace) {
        errors.push(`Could not find workspace for ${name}.`);
        return { errors, dependencies };
    }

    const pkg: PackageJson = getPackageJson(workspace);

    for (const [dependencyName, version] of Object.entries(pkg.dependencies || {})) {
        dependencies.set(dependencyName, version);
    }

    return { errors, dependencies };
};

// Based on the internal dependencies, we need to verify that the declared dependencies are correct
// in the published packages.
export const updateDependencies = async (workspaces: Workspace[], bundlers: Workspace[]) => {
    const errors: string[] = [];
    for (const bundler of bundlers) {
        console.log(`  Verifying ${green('dependencies')} for ${green(bundler.name)}.`);
        const pkg = getPackageJson(bundler);
        const currentDependencies = cleanDependencies(pkg.dependencies, allDependencies);
        const recordedDependencies: Record<string, string> = {};
        const internalDependencies = getInternalDependencies(workspaces, bundler);
        errors.push(...internalDependencies.errors);

        // Look through the internal dependencies we're loading.
        for (const internalDep of internalDependencies.dependencies) {
            const externalDependencies = getDependencies(workspaces, internalDep);
            errors.push(...externalDependencies.errors);

            for (const [depName, depVersion] of externalDependencies.dependencies) {
                if (recordedDependencies[depName] && recordedDependencies[depName] !== depVersion) {
                    errors.push(
                        `Dependency mismatch for ${depName} in ${bundler.name}: ${recordedDependencies[depName]} vs ${depVersion}`,
                    );
                    continue;
                }

                recordedDependencies[depName] = depVersion;
            }
        }

        const expectedDependencies: Record<string, string> = cleanDependencies(
            recordedDependencies,
            onlyExternalDependencies,
        );

        // First list all the dependencies we need to check.
        const depdenciesToCheck = new Map([
            ...Object.entries(expectedDependencies),
            ...Object.entries(currentDependencies),
        ]);

        // Crawl through each list and identify the differences.
        let dependenciesMatch = true;
        let outputLog = `{`;
        const newDependenciesToApply = { ...pkg.dependencies };
        for (const [depName, depVersion] of depdenciesToCheck) {
            if (!currentDependencies[depName]) {
                // Missing dependency.
                dependenciesMatch = false;
                newDependenciesToApply[depName] = depVersion;
                outputLog += green(`\n +  "${depName}": "${depVersion}"`);
            } else if (!expectedDependencies[depName]) {
                // Extra dependency.
                dependenciesMatch = false;
                delete newDependenciesToApply[depName];
                outputLog += red(`\n -  "${depName}": "${depVersion}"`);
            } else if (
                currentDependencies[depName] !== depVersion ||
                expectedDependencies[depName] !== depVersion
            ) {
                // Mismatching versions.
                dependenciesMatch = false;
                newDependenciesToApply[depName] = expectedDependencies[depName];
                outputLog += red(`\n -  "${depName}": "${currentDependencies[depName]}"`);
                outputLog += green(`\n +  "${depName}": "${expectedDependencies[depName]}"`);
            } else {
                // All good.
                outputLog += dim(`\n    "${depName}": "${depVersion}"`);
            }
        }
        outputLog += '\n}';

        if (!dependenciesMatch) {
            // Log the error.
            console.log(
                `    Missmatch ${red('dependencies')} for ${red(bundler.name)}:\n${outputLog}`,
            );
            // Fix the dependencies.
            pkg.dependencies = newDependenciesToApply;
            console.log(`    Writing ${red('package.json')} of ${red(bundler.name)}.`);
            fs.writeJSONSync(path.resolve(ROOT, bundler.location, 'package.json'), pkg, {
                spaces: 4,
            });
        }
    }

    return errors.map((error) => `[${red('Error')}] ${error}`);
};
