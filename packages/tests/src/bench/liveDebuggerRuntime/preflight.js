// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BENCH_BUNDLER = 'rspack';
const BENCH_OUTPUT_ENTRY = `${BENCH_BUNDLER}.js`;
const FIXTURE_SOURCE = path.resolve(__dirname, 'project');
const ROOT = path.resolve(__dirname, '../../../../..');
const WORKSPACE_NAME = '@datadog/rspack-plugin';

const forceRunPaths = [
    '.github/actions/setup-playwright-build/',
    '.github/workflows/ci.yaml',
    'package.json',
    'packages/tests/package.json',
    'packages/tests/playwright.live-debugger-runtime.config.ts',
    'packages/tests/src/_playwright/',
    'packages/tests/src/bench/liveDebuggerRuntime/',
    'packages/tools/src/bundlers.ts',
    'packages/tools/src/commands/dev-server/',
    'packages/tools/src/plugins.ts',
    'yarn.lock',
];

function exec(command, options = {}) {
    return childProcess.execFileSync(command[0], command.slice(1), {
        cwd: options.cwd || ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            FORCE_COLOR: 'true',
            PROJECT_CWD: ROOT,
            ...options.env,
        },
        stdio: options.stdio || 'pipe',
    });
}

function getArgValue(name) {
    const prefix = `${name}=`;
    const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));

    return match ? match.slice(prefix.length) : undefined;
}

function hasArg(name) {
    return process.argv.includes(name);
}

function appendGithubOutput(values) {
    if (!process.env.GITHUB_OUTPUT) {
        return;
    }

    const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function normalizeChangedPath(filePath) {
    return filePath.replace(/\\/g, '/');
}

function getChangedFiles(baseRef) {
    const diffOutput = exec(['git', 'diff', '--name-only', `${baseRef}...HEAD`]);

    return diffOutput.split('\n').filter(Boolean).map(normalizeChangedPath);
}

function getForceRunReason(changedFiles) {
    const matchingPath = changedFiles.find((filePath) =>
        forceRunPaths.some((forceRunPath) => {
            if (forceRunPath.endsWith('/')) {
                return filePath.startsWith(forceRunPath);
            }

            return filePath === forceRunPath;
        }),
    );

    return matchingPath ? `changed:${matchingPath}` : '';
}

function copyFixture(destination) {
    fs.cpSync(FIXTURE_SOURCE, destination, {
        recursive: true,
        force: true,
    });
}

function cleanPublishedPlugin() {
    exec(['yarn', 'workspace', WORKSPACE_NAME, 'clean'], { stdio: 'inherit' });
}

function buildPublishedPlugin() {
    exec(['yarn', 'workspace', WORKSPACE_NAME, 'build'], {
        env: {
            NO_TYPES: '1',
        },
        stdio: 'inherit',
    });
}

function buildFixture(fixturePath) {
    const buildScript = path.resolve(__dirname, 'preflight-build.js');

    exec(['node', buildScript, fixturePath, BENCH_BUNDLER], { stdio: 'inherit' });
}

function hashOutput(fixturePath) {
    const outputPath = path.resolve(fixturePath, 'dist', BENCH_OUTPUT_ENTRY);
    const code = fs.readFileSync(outputPath);

    return crypto.createHash('sha256').update(code).digest('hex');
}

function captureOutputHash(worktreeRef, tempRoot) {
    const fixturePath = path.resolve(tempRoot, 'fixture');

    exec(['git', 'checkout', '--quiet', worktreeRef], { stdio: 'inherit' });
    fs.rmSync(fixturePath, { recursive: true, force: true });
    copyFixture(fixturePath);
    cleanPublishedPlugin();
    buildPublishedPlugin();
    buildFixture(fixturePath);

    return hashOutput(fixturePath);
}

function writeResult(shouldRun, reason) {
    console.log(`should-run=${shouldRun}`);
    console.log(`reason=${reason}`);
    appendGithubOutput({
        'should-run': shouldRun ? 'true' : 'false',
        reason,
    });
}

function runChangedFilesMode(baseRef) {
    const changedFiles = getChangedFiles(baseRef);
    const reason = getForceRunReason(changedFiles);

    writeResult(Boolean(reason), reason);
}

function runCompareOutputMode(baseRef) {
    const originalRef = exec(['git', 'rev-parse', 'HEAD']).trim();
    const originalBranch = exec(['git', 'branch', '--show-current']).trim();
    const restoreRef = originalBranch || originalRef;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-runtime-bench-preflight-'));

    try {
        const baseHash = captureOutputHash(baseRef, tempRoot);
        const headHash = captureOutputHash(originalRef, tempRoot);
        const changed = baseHash !== headHash;
        const reason = changed ? 'build-output-changed' : 'build-output-unchanged';

        console.log(`base-hash=${baseHash}`);
        console.log(`head-hash=${headHash}`);
        writeResult(changed, reason);
    } finally {
        exec(['git', 'checkout', '--quiet', restoreRef], { stdio: 'inherit' });
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function main() {
    const baseRef = getArgValue('--base-ref') || 'origin/main';

    if (hasArg('--changed-files')) {
        runChangedFilesMode(baseRef);
        return;
    }

    if (hasArg('--compare-output')) {
        runCompareOutputMode(baseRef);
        return;
    }

    throw new Error('Expected --changed-files or --compare-output.');
}

try {
    main();
} catch (error) {
    if (!process.env.CI) {
        throw error;
    }

    console.error(error);
    writeResult(true, 'preflight-error');
}
