// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFileSync } from '@dd/core/helpers/fs';
import { getClosestPackageJson } from '@dd/core/helpers/paths';
import { filterSensitiveInfoFromRepositoryUrl } from '@dd/core/helpers/strings';
import type { Logger } from '@dd/core/types';
import chalk from 'chalk';

const red = chalk.bold.red;
const yellow = chalk.bold.yellow;

type PkgJson = {
    name?: string;
    repository?:
        | string
        | {
              type: string;
              url: string;
          };
};

const getPackageJson = (buildRoot: string): PkgJson | undefined => {
    const packageJsonPath = getClosestPackageJson(buildRoot);
    if (!packageJsonPath) {
        return undefined;
    }
    try {
        const packageJson = readFileSync(packageJsonPath);
        return JSON.parse(packageJson);
    } catch (e) {
        // Let the caller handle the warnings.
        return undefined;
    }
};

const getRepositoryUrlFromPkg = (pkg?: PkgJson): string | undefined => {
    if (!pkg || !pkg.repository) {
        return undefined;
    }

    if (typeof pkg.repository === 'string') {
        return pkg.repository;
    }

    if ('url' in pkg.repository) {
        return pkg.repository.url;
    }

    return undefined;
};

const resolveRepositoryUrl = (inputRepositoryUrl?: string, pkg?: PkgJson): string | undefined => {
    const repositoryUrl = inputRepositoryUrl || getRepositoryUrlFromPkg(pkg);
    if (!repositoryUrl) {
        return undefined;
    }

    const sanitizedUrl = filterSensitiveInfoFromRepositoryUrl(repositoryUrl.trim());
    if (!sanitizedUrl) {
        return undefined;
    }

    return sanitizedUrl.replace(/\.git$/, '');
};

const buildIdentifier = (repository?: string, name?: string): string | undefined => {
    if (repository && name) {
        return `${repository}:${name}`;
    }

    return repository || name;
};

export const resolveIdentifier = (
    buildRoot: string,
    log: Logger,
    repositoryUrl?: string,
): string | undefined => {
    const pkg = getPackageJson(buildRoot);
    if (!pkg) {
        log.warn(yellow('No package.json found to infer the app name.'));
    }

    const name = pkg?.name?.trim();
    if (!name) {
        log.error(red('Unable to determine the app name to compute the app identifier.'));
    }

    const repository = resolveRepositoryUrl(repositoryUrl);
    if (!repository) {
        log.error(red('Unable to determine the git remote to compute the app identifier.'));
    }

    const identifier = buildIdentifier(repository, name);
    if (!identifier) {
        log.error(red('Unable to compute the app identifier.'));
    }

    return identifier;
};
