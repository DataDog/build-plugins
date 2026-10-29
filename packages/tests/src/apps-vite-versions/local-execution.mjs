// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

// Jest can't load the ESM-only Vite 7+, so node:test runs this against a real install of one Vite
// version; the name stays out of Jest's *.test.* match. Run it with DD_APPS_TEST_VITE_VERSION and
// DD_APPS_TEST_PLUGIN_TGZ (a packed @datadog/vite-plugin) set.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VITE_VERSION = process.env.DD_APPS_TEST_VITE_VERSION;
const PLUGIN_TGZ =
    process.env.DD_APPS_TEST_PLUGIN_TGZ && path.resolve(process.env.DD_APPS_TEST_PLUGIN_TGZ);
// A missing variable fails the run, since a skipped suite would pass CI with nothing tested.
if (!VITE_VERSION || !PLUGIN_TGZ) {
    throw new Error('Set DD_APPS_TEST_VITE_VERSION and DD_APPS_TEST_PLUGIN_TGZ.');
}
const TESTS_FILE = fileURLToPath(import.meta.url);
const TESTS_DIR = path.dirname(TESTS_FILE);
const FIXTURE_DIR = path.resolve(TESTS_DIR, '../_jest/fixtures/apps_backend_project');
// Outside the OS temp dir, which the sandbox lets a call write to; the project itself lives there.
const OUTSIDE_TMP_DIR = path.resolve(TESTS_DIR, '../../../../node_modules/.cache');
const FIXTURE_FILES = ['childState.backend.ts', 'getRuntimeUsers.backend.ts'];
const fixturePackageJsonPath = path.join(FIXTURE_DIR, 'package.json');
const fixturePackageJsonText = fs.readFileSync(fixturePackageJsonPath, 'utf-8');
const APPS_BACKEND_VERSION =
    JSON.parse(fixturePackageJsonText).dependencies['@datadog/apps-backend'];
if (!/^\d+\.\d+\.\d+$/.test(VITE_VERSION)) {
    throw new Error(`DD_APPS_TEST_VITE_VERSION must be an exact version, not ${VITE_VERSION}.`);
}

const realFetch = globalThis.fetch;
const runtimeContext = {
    Source: {
        initiator: { id: 'matrix-initiator', orgId: 'matrix-org' },
        runAsUser: { id: 'matrix-run-as', orgId: 'matrix-org' },
    },
};

async function fakeDatadogApi(input, init) {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/v2/app-builder/queries/preview-async')) {
        return Response.json({ data: { id: 'matrix-receipt' } });
    }
    if (url.includes('/api/v2/app-builder/queries/execution-long-polling/')) {
        const outputs = { data: runtimeContext };
        return Response.json({ data: { attributes: { done: true, outputs } } });
    }
    return realFetch(input, init);
}

// A package, since the dev server's static checks refuse these imports in app code.
const SANDBOX_PROBES = `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const attempt = (run) => {
    try {
        return 'ok: ' + run();
    } catch (error) {
        return 'refused: ' + (error.code ?? error.message);
    }
};
exports.probeSandbox = async (targetFile, fetchUrl) => ({
    fetch: await fetch(fetchUrl).then((response) => 'ok: ' + response.status, (error) => 'refused: ' + error.message),
    outsideTmpWrite: attempt(() => (fs.writeFileSync(targetFile, 'x'), 'written')),
    tempWrite: attempt(() => {
        const tempFile = path.join(os.tmpdir(), 'sandbox-probe-' + process.pid + '.txt');
        fs.writeFileSync(tempFile, 'x');
        const written = fs.readFileSync(tempFile, 'utf-8');
        fs.rmSync(tempFile);
        return written;
    }),
    spawn: attempt(() => {
        const spawned = spawnSync('echo', ['hi']);
        if (spawned.error) throw spawned.error;
        return String(spawned.stdout);
    }),
});
`;
const SANDBOX_BACKEND = `
import { probeSandbox } from 'sandbox-probes';

export async function runSandboxProbes(targetFile: string, fetchUrl: string) {
    return probeSandbox(targetFile, fetchUrl);
}
`;

function isUnder(root, filePath) {
    const relativePath = path.relative(root, filePath);
    const escapes = relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
    return !escapes && !path.isAbsolute(relativePath);
}

function installProject(projectDir) {
    for (const file of FIXTURE_FILES) {
        const fixturePath = path.join(FIXTURE_DIR, file);
        const projectPath = path.join(projectDir, file);
        fs.copyFileSync(fixturePath, projectPath);
    }
    const sandboxBackendPath = path.join(projectDir, 'sandbox.backend.ts');
    fs.writeFileSync(sandboxBackendPath, SANDBOX_BACKEND);
    const packageJson = {
        name: 'apps-vite-versions',
        private: true,
        type: 'module',
        dependencies: {
            '@datadog/apps-backend': APPS_BACKEND_VERSION,
            '@datadog/vite-plugin': `file:${PLUGIN_TGZ}`,
            vite: VITE_VERSION,
        },
    };
    const packageJsonPath = path.join(projectDir, 'package.json');
    const packageJsonText = JSON.stringify(packageJson);
    fs.writeFileSync(packageJsonPath, packageJsonText);
    // npm 10's peer resolution crashes ("reading 'edgesOut'") on the plugin's optional peers. The
    // install isn't locked, so its packages' install scripts don't run.
    const npmArgs = [
        'install',
        '--no-audit',
        '--no-fund',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--loglevel=error',
    ];
    execFileSync('npm', npmArgs, {
        cwd: projectDir,
        stdio: 'inherit',
    });
    const probesDir = path.join(projectDir, 'node_modules', 'sandbox-probes');
    fs.mkdirSync(probesDir);
    const probesPackageJsonPath = path.join(probesDir, 'package.json');
    fs.writeFileSync(probesPackageJsonPath, '{"name":"sandbox-probes","main":"index.js"}');
    const probesIndexPath = path.join(probesDir, 'index.js');
    fs.writeFileSync(probesIndexPath, SANDBOX_PROBES);
}

function setUpProject() {
    const osTmpDir = os.tmpdir();
    const tmpDir = fs.realpathSync(osTmpDir);
    const projectPrefix = path.join(tmpDir, `dd-apps-vite-${VITE_VERSION}-`);
    const projectDir = fs.mkdtempSync(projectPrefix);
    try {
        installProject(projectDir);
    } catch (error) {
        fs.rmSync(projectDir, { recursive: true, force: true });
        throw error;
    }
    return projectDir;
}

// `npm pack` keeps the repo's source-pointing exports (publishing swaps in publishConfig), so load
// the plugin's built entry by path; it still resolves `vite` from the project like a customer's.
function importFromProject(projectDir, relativePath) {
    const filePath = path.join(projectDir, 'node_modules', relativePath);
    const fileUrl = pathToFileURL(filePath);
    return import(fileUrl.href);
}

describe(`Local execution on Vite ${VITE_VERSION}`, () => {
    let projectDir;
    let server;
    let baseUrl;
    const terminalLines = { stdout: [], stderr: [] };
    const writes = {
        stdout: process.stdout.write.bind(process.stdout),
        stderr: process.stderr.write.bind(process.stderr),
    };

    before(async () => {
        projectDir = setUpProject();
        globalThis.fetch = fakeDatadogApi;
        // Without it the plugin runs as production and sends its own telemetry.
        process.env.BUILD_PLUGINS_ENV = 'test';
        process.env.DD_API_KEY = 'matrix-api-key';
        process.env.DD_APP_KEY = 'matrix-app-key';
        for (const stream of ['stdout', 'stderr']) {
            process[stream].write = (chunk, ...rest) => {
                const lines = String(chunk).split('\n').filter(Boolean);
                terminalLines[stream].push(...lines);
                return writes[stream](chunk, ...rest);
            };
        }
        const vite = await importFromProject(projectDir, 'vite/dist/node/index.js');
        const { datadogVitePlugin } = await importFromProject(
            projectDir,
            '@datadog/vite-plugin/dist/src/index.mjs',
        );
        const plugin = datadogVitePlugin({
            auth: { site: 'datadoghq.com' },
            apps: { enable: true },
        });
        server = await vite.createServer({
            configFile: false,
            root: projectDir,
            logLevel: 'error',
            server: { port: 0, strictPort: false, hmr: false },
            optimizeDeps: { noDiscovery: true },
            plugins: [plugin],
        });
        await server.listen();
        baseUrl = `http://localhost:${server.httpServer.address().port}`;
    });

    after(async () => {
        process.stdout.write = writes.stdout;
        process.stderr.write = writes.stderr;
        globalThis.fetch = realFetch;
        await server?.close();
        if (projectDir) {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }
    });

    async function functionName(file, exportName) {
        const proxy = await (await realFetch(`${baseUrl}/${file}`)).text();
        const names = [...proxy.matchAll(/executeBackendFunction\("([^"]+)"/g)].map((m) => m[1]);
        const name = names.find((candidate) => candidate.endsWith(`.${exportName}`));
        assert.ok(name, `No proxy for ${exportName} in ${file}:\n${proxy}`);
        return name;
    }

    async function execute(file, exportName, args) {
        const name = await functionName(file, exportName);
        const requestBody = JSON.stringify({ functionName: name, args });
        const response = await realFetch(`${baseUrl}/__dd/executeAction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody,
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const body = JSON.parse(text);
        return body.result.data;
    }

    test('module state is fresh per call, each in its own process', async () => {
        const first = await execute('childState.backend.ts', 'countCalls', [0]);
        const second = await execute('childState.backend.ts', 'countCalls', [0]);
        assert.deepEqual([first.calls, second.calls, second.globalCalls], [1, 1, 1]);
        assert.notEqual(first.pid, process.pid);
        assert.notEqual(first.pid, second.pid);
    });

    test('concurrent calls run in parallel', async () => {
        // Leaves the last of four cold starts room to begin before the first call ends.
        const delayMs = 3000;
        await execute('childState.backend.ts', 'countCalls', [0]);
        const calls = [1, 2, 3, 4].map(() =>
            execute('childState.backend.ts', 'countCalls', [delayMs]),
        );
        const runs = await Promise.all(calls);
        const byStart = [...runs].sort((a, b) => a.startedAt - b.startedAt);
        // Every call started before any ended, so all four ran at once.
        const endTimes = runs.map((run) => run.endedAt);
        const firstEnd = Math.min(...endTimes);
        assert.ok(byStart[3].startedAt < firstEnd, JSON.stringify(runs));
    });

    test('the sandbox refuses writes outside the temp dir and subprocesses, and allows temp writes', async (t) => {
        const tmpRoots = ['/tmp', os.tmpdir()]
            .filter((root) => fs.existsSync(root))
            .flatMap((root) => [root, fs.realpathSync(root)]);
        fs.mkdirSync(OUTSIDE_TMP_DIR, { recursive: true });
        const realOutsideDir = fs.realpathSync(OUTSIDE_TMP_DIR);
        assert.ok(
            !tmpRoots.some((root) => isUnder(root, realOutsideDir)),
            `Run from a checkout outside the temp dir: ${realOutsideDir} is inside one.`,
        );
        const targetFile = path.join(
            OUTSIDE_TMP_DIR,
            `apps-vite-${VITE_VERSION}-probe-${process.pid}.txt`,
        );
        t.after(() => fs.rmSync(targetFile, { force: true }));
        const result = await execute('sandbox.backend.ts', 'runSandboxProbes', [
            targetFile,
            `${baseUrl}/childState.backend.ts`,
        ]);
        assert.equal(result.tempWrite, 'ok: x');
        assert.equal(result.outsideTmpWrite, 'refused: ERR_ACCESS_DENIED');
        assert.equal(result.spawn, 'refused: ERR_ACCESS_DENIED');
        assert.match(result.fetch, /^ok: 200/);
        assert.equal(fs.existsSync(targetFile), false);
    });

    test('$.Source resolves through @datadog/apps-backend', async () => {
        const result = await execute('getRuntimeUsers.backend.ts', 'getRuntimeUsers', ['matrix']);
        assert.deepEqual(result, {
            label: 'matrix',
            executionUser: runtimeContext.Source.runAsUser,
            initiatingUser: runtimeContext.Source.initiator,
        });
    });

    test("console output reaches the dev server's terminal, prefixed with its call", async () => {
        await execute('childState.backend.ts', 'logLines', [0]);
        const { stdout, stderr } = terminalLines;
        const prefix = String.raw`\[logLines#\d+\] `;
        const has = (lines, text) =>
            lines.some((line) => new RegExp(`^${prefix}${text}$`).test(line));
        assert.ok(has(stdout, 'first line'), stdout.join('\n'));
        assert.ok(has(stderr, 'second line'), stderr.join('\n'));
        assert.ok(has(stdout, 'no trailing newline'), stdout.join('\n'));
    });
});
