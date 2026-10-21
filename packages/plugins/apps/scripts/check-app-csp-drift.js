// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */

// Compares the dev server's copy of the app CSP with its production source in a web-ui
// checkout, which CI can't read: yarn workspace @dd/apps-plugin check-app-csp-drift <checkout> [ref],
// with the checkout's path absolute or relative to this repository's root.

const { execFileSync } = require('child_process');
const { transformSync } = require('esbuild');
const fs = require('fs');
const path = require('path');
const { runInNewContext } = require('vm');

const APP_CSP_PATH = path.resolve(__dirname, '../src/vite/app-csp.ts');

// Runs a module with no imports; an import means the source changed shape.
const loadExports = (source, label) => {
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
    const sandboxModule = { exports: {} };
    const require = () => {
        throw new Error(`${label} imports another module, so it can't be checked on its own.`);
    };
    runInNewContext(code, { module: sandboxModule, exports: sandboxModule.exports, require });
    return sandboxModule.exports;
};

const toDirectives = (policy) =>
    policy
        .split(';')
        .map((directive) => directive.trim().split(/\s+/).join(' '))
        .filter((directive) => directive && !directive.startsWith('frame-ancestors'));

const compare = (webUiRoot, ref) => {
    const git = (...args) =>
        execFileSync('git', ['-C', webUiRoot, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();

    // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
    const appCspSource = fs.readFileSync(APP_CSP_PATH, 'utf8');
    const { APP_CSP_SOURCE, formatAppCsp } = loadExports(appCspSource, APP_CSP_PATH);
    const productionSource = git('show', `${ref}:${APP_CSP_SOURCE.file}`);
    const { getAppCsp } = loadExports(productionSource, APP_CSP_SOURCE.file);
    if (typeof getAppCsp !== 'function') {
        throw new Error(`${APP_CSP_SOURCE.file} at ${ref} does not export getAppCsp.`);
    }

    const productionPolicy = getAppCsp("'none'");
    const production = toDirectives(productionPolicy);
    const copyPolicy = formatAppCsp({});
    const copy = toDirectives(copyPolicy);
    const latestCommit = git(
        'log',
        '-1',
        '--no-show-signature',
        '--format=%H',
        ref,
        '--',
        APP_CSP_SOURCE.file,
    );

    if (JSON.stringify(production) !== JSON.stringify(copy)) {
        console.log(`The app CSP copy differs from ${APP_CSP_SOURCE.file} at ${latestCommit}:`);
        for (const directive of production.filter((line) => !copy.includes(line))) {
            console.log(`  production: ${directive}`);
        }
        for (const directive of copy.filter((line) => !production.includes(line))) {
            console.log(`  copy:       ${directive}`);
        }
        if (production.every((line) => copy.includes(line)) && production.length === copy.length) {
            const order = production.map((line) => line.split(' ')[0]).join(', ');
            console.log(`  directive order: ${order}`);
        }
        console.log(`Update APP_CSP_DIRECTIVES and APP_CSP_SOURCE.commit in ${APP_CSP_PATH}.`);
        return 1;
    }
    if (latestCommit !== APP_CSP_SOURCE.commit) {
        console.log(
            `The app CSP copy matches, but set APP_CSP_SOURCE.commit to ${latestCommit}, the source's latest change.`,
        );
        return 0;
    }
    console.log(`The app CSP copy matches ${APP_CSP_SOURCE.file} at ${latestCommit}.`);
    return 0;
};

const main = () => {
    const [webUiPath, ref = 'origin/preprod'] = process.argv.slice(2);
    if (!webUiPath) {
        console.error('Usage: check-app-csp-drift <web-ui checkout> [ref, default origin/preprod]');
        return 2;
    }
    if (ref.startsWith('-')) {
        console.error(`A ref can't start with '-', which git reads as an option: ${ref}`);
        return 2;
    }
    // yarn workspace runs this from the package, so a relative path is taken from the repo root.
    const projectRoot = process.env.PROJECT_CWD || process.cwd();
    const webUiRoot = path.resolve(projectRoot, webUiPath);
    try {
        return compare(webUiRoot, ref);
    } catch (error) {
        const gitError = error && error.stderr ? String(error.stderr).trim() : '';
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Could not compare the app CSP at ${ref}: ${gitError || message}`);
        return 1;
    }
};

process.exitCode = main();
