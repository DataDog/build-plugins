// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJsonSync, readJsonSync } from '@dd/core/helpers/fs';
import { ROOT } from '@dd/tools/constants';
import { dim, green, red } from '@dd/tools/helpers';
import type { Workspace } from '@dd/tools/types';
import path from 'path';

type PackageJson = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
};

const jsonCache: Map<string, PackageJson> = new Map();

const getPackageJson = (workspace: Workspace) => {
    const pkg: PackageJson =
        jsonCache.get(workspace.name) ||
        readJsonSync(path.resolve(ROOT, workspace.location, 'package.json'));
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

type DependencyType = 'dependencies' | 'optionalDependencies';

const mergeDependency = (
    dependencies: Map<string, string>,
    errors: string[],
    workspaceName: string,
    dependencyName: string,
    version: string,
) => {
    const recordedVersion = dependencies.get(dependencyName);
    if (recordedVersion && recordedVersion !== version) {
        errors.push(
            `Dependency mismatch for ${dependencyName} in ${workspaceName}: ${recordedVersion} vs ${version}`,
        );
        return;
    }

    dependencies.set(dependencyName, version);
};

// From a workspace name, returns its dependencies and their versions.
const getDependencies = (workspaces: Workspace[], name: string) => {
    const errors: string[] = [];
    const dependencies: Map<string, string> = new Map();
    const optionalDependencies: Map<string, string> = new Map();

    const workspace = workspaces.find((w) => w.name === name);
    if (!workspace) {
        errors.push(`Could not find workspace for ${name}.`);
        return { errors, dependencies, optionalDependencies };
    }

    const pkg: PackageJson = getPackageJson(workspace);

    for (const [dependencyName, version] of Object.entries(pkg.dependencies || {})) {
        dependencies.set(dependencyName, version);
    }

    for (const [dependencyName, version] of Object.entries(pkg.optionalDependencies || {})) {
        optionalDependencies.set(dependencyName, version);
    }

    return { errors, dependencies, optionalDependencies };
};

const getExpectedDependencies = (
    workspaces: Workspace[],
    bundler: Workspace,
    internalDependencies: Set<string>,
    errors: string[],
) => {
    const dependencies: Map<string, string> = new Map();
    const optionalDependencies: Map<string, string> = new Map();

    // Look through the internal dependencies we're loading.
    for (const internalDep of internalDependencies) {
        const externalDependencies = getDependencies(workspaces, internalDep);
        errors.push(...externalDependencies.errors);

        for (const [depName, depVersion] of externalDependencies.dependencies) {
            mergeDependency(dependencies, errors, bundler.name, depName, depVersion);
        }

        for (const [depName, depVersion] of externalDependencies.optionalDependencies) {
            mergeDependency(optionalDependencies, errors, bundler.name, depName, depVersion);
        }
    }

    // Required dependencies win if a transitive workspace lists the same package
    // as optional while another requires it.
    for (const depName of dependencies.keys()) {
        optionalDependencies.delete(depName);
    }

    return {
        dependencies: cleanDependencies(Object.fromEntries(dependencies), onlyExternalDependencies),
        optionalDependencies: cleanDependencies(
            Object.fromEntries(optionalDependencies),
            onlyExternalDependencies,
        ),
    };
};

const syncDependencyRecord = (
    pkg: PackageJson,
    dependencyType: DependencyType,
    currentDependencies: Record<string, string>,
    expectedDependencies: Record<string, string>,
) => {
    // First list all the dependencies we need to check.
    const dependenciesToCheck = new Map([
        ...Object.entries(expectedDependencies),
        ...Object.entries(currentDependencies),
    ]);

    // Crawl through each list and identify the differences.
    let dependenciesMatch = true;
    let outputLog = `{`;
    const newDependenciesToApply = { ...(pkg[dependencyType] || {}) };
    for (const [depName, depVersion] of dependenciesToCheck) {
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

    return { dependenciesMatch, newDependenciesToApply, outputLog };
};

const applyOptionalDependencies = (
    pkg: PackageJson,
    optionalDependencies: Record<string, string>,
) => {
    if (Object.keys(optionalDependencies).length === 0) {
        delete pkg.optionalDependencies;
        return;
    }

    pkg.optionalDependencies = optionalDependencies;
};

// Based on the internal dependencies, we need to verify that the declared dependencies are correct
// in the published packages.
export const updateDependencies = async (workspaces: Workspace[], bundlers: Workspace[]) => {
    const errors: string[] = [];
    for (const bundler of bundlers) {
        console.log(`  Verifying ${green('dependencies')} for ${green(bundler.name)}.`);
        const pkg = getPackageJson(bundler);
        const currentDependencies = cleanDependencies(pkg.dependencies, allDependencies);
        const currentOptionalDependencies = cleanDependencies(
            pkg.optionalDependencies,
            allDependencies,
        );
        const internalDependencies = getInternalDependencies(workspaces, bundler);
        errors.push(...internalDependencies.errors);
        const expected = getExpectedDependencies(
            workspaces,
            bundler,
            internalDependencies.dependencies,
            errors,
        );

        const dependenciesSync = syncDependencyRecord(
            pkg,
            'dependencies',
            currentDependencies,
            expected.dependencies,
        );
        const optionalDependenciesSync = syncDependencyRecord(
            pkg,
            'optionalDependencies',
            currentOptionalDependencies,
            expected.optionalDependencies,
        );

        let shouldWritePackageJson = false;

        if (!dependenciesSync.dependenciesMatch) {
            // Log the error.
            console.log(
                `    Mismatch ${red('dependencies')} for ${red(bundler.name)}:\n${dependenciesSync.outputLog}`,
            );
            // Fix the dependencies.
            pkg.dependencies = dependenciesSync.newDependenciesToApply;
            shouldWritePackageJson = true;
        }

        if (!optionalDependenciesSync.dependenciesMatch) {
            // Log the error.
            console.log(
                `    Mismatch ${red('optionalDependencies')} for ${red(bundler.name)}:\n${optionalDependenciesSync.outputLog}`,
            );
            // Fix the dependencies.
            applyOptionalDependencies(pkg, optionalDependenciesSync.newDependenciesToApply);
            shouldWritePackageJson = true;
        }

        if (shouldWritePackageJson) {
            console.log(`    Writing ${red('package.json')} of ${red(bundler.name)}.`);
            outputJsonSync(path.resolve(ROOT, bundler.location, 'package.json'), pkg);
        }
    }

    return errors.map((error) => `[${red('Error')}] ${error}`);
};
