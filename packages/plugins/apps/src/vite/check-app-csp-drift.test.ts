// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { APP_CSP_DIRECTIVES, APP_CSP_SOURCE } from '@dd/apps-plugin/vite/app-csp';
import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';

const DRIFT_SCRIPT = path.resolve(__dirname, '../../scripts/check-app-csp-drift.js');
const DRIFT_SCRIPT_DIR = path.dirname(DRIFT_SCRIPT);

type Directives = ReadonlyArray<readonly [string, readonly string[]]>;

// The shape of the production source: a function joining directives, frame-ancestors last.
const formatSource = (directives: Directives) =>
    [
        'export function getAppCsp(frameAncestors: string): string {',
        '    return [',
        ...directives.map(
            ([name, sources]) => `        ${JSON.stringify([name, ...sources].join(' '))},`,
        ),
        "        'frame-ancestors ' + frameAncestors,",
        "    ].join('; ');",
        '}',
        '',
    ].join('\n');

describe('check-app-csp-drift script', () => {
    let repository: string;

    const git = (...args: string[]) =>
        execFileSync(
            'git',
            [
                '-C',
                repository,
                '-c',
                'user.name=test',
                '-c',
                'user.email=test@example.com',
                '-c',
                'commit.gpgsign=false',
                '-c',
                'core.hooksPath=/dev/null',
                ...args,
            ],
            { encoding: 'utf8' },
        ).trim();

    const commitRawSource = (source: string) => {
        const sourcePath = path.join(repository, APP_CSP_SOURCE.file);
        outputFileSync(sourcePath, source);
        git('add', '-A');
        git('commit', '-q', '-m', 'csp');
        return git('rev-parse', 'HEAD');
    };

    const commitSource = (directives: Directives) => {
        const source = formatSource(directives);
        return commitRawSource(source);
    };

    const runScript = (...args: string[]) =>
        spawnSync(process.execPath, [DRIFT_SCRIPT, ...args], { encoding: 'utf8' });

    const runScriptFrom = (projectCwd: string, ...args: string[]) =>
        spawnSync(process.execPath, [DRIFT_SCRIPT, ...args], {
            cwd: DRIFT_SCRIPT_DIR,
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME, PROJECT_CWD: projectCwd },
        });

    beforeEach(() => {
        repository = getTempWorkingDir(`apps-csp-drift-${Date.now()}`);
        git('init', '-q');
    });

    afterEach(() => {
        rmSync(repository);
    });

    test('Should pass and name the commit to record when only the source commit moved', () => {
        const commit = commitSource(APP_CSP_DIRECTIVES);
        const result = runScript(repository, 'HEAD');

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(commit);
    });

    test('Should name a bare commit when git log shows signatures', () => {
        const keyDir = getTempWorkingDir(`apps-csp-drift-key-${Date.now()}`);
        try {
            const keyPath = path.join(keyDir, 'key');
            execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
            git('config', 'gpg.format', 'ssh');
            git('config', 'user.signingkey', keyPath);
            git('config', 'log.showSignature', 'true');
            const sourcePath = path.join(repository, APP_CSP_SOURCE.file);
            const source = formatSource(APP_CSP_DIRECTIVES);
            outputFileSync(sourcePath, source);
            git('add', '-A');
            git('commit', '-q', '-S', '-m', 'csp');
            const commit = git('rev-parse', 'HEAD');
            const result = runScript(repository, 'HEAD');

            expect(result.status).toBe(0);
            expect(result.stdout).toContain(`set APP_CSP_SOURCE.commit to ${commit},`);
        } finally {
            rmSync(keyDir);
        }
    });

    test('Should fail and name the directive that drifted', () => {
        const drifted: Directives = APP_CSP_DIRECTIVES.map(([name, sources]) =>
            name === 'img-src' ? [name, [...sources, 'https:']] : [name, sources],
        );
        commitSource(drifted);
        const result = runScript(repository, 'HEAD');

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('img-src');
        expect(result.stdout).toContain('https:');
    });

    test('Should pass when only the source formatting differs', () => {
        const source = formatSource(APP_CSP_DIRECTIVES)
            .replace("].join('; ');", "].join(';  ') + ';';")
            .replace("'self' 'unsafe-inline'", "'self'  'unsafe-inline'");
        commitRawSource(source);
        const result = runScript(repository, 'HEAD');

        expect(result.status).toBe(0);
    });

    const failureCases: { description: string; source: string; ref: string; message: string }[] = [
        {
            description: 'no longer exports getAppCsp',
            source: 'export const other = 1;\n',
            ref: 'HEAD',
            message: 'getAppCsp',
        },
        {
            description: 'imports another module',
            source: "import { x } from './x';\nexport const getAppCsp = () => x;\n",
            ref: 'HEAD',
            message: 'imports',
        },
        {
            description: 'is read at a ref the checkout lacks',
            source: formatSource(APP_CSP_DIRECTIVES),
            ref: 'origin/no-such-branch',
            message: 'origin/no-such-branch',
        },
    ];

    test.each(failureCases)(
        'Should fail with a clear message when the source $description',
        ({ source, ref, message }) => {
            commitRawSource(source);
            const result = runScript(repository, ref);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain(message);
            expect(result.stderr).not.toMatch(/^\s+at /m);
        },
    );

    test('Should resolve a relative checkout path from the repository root', () => {
        commitSource(APP_CSP_DIRECTIVES);
        const parent = path.dirname(repository);
        const relativeRepository = path.basename(repository);
        const result = runScriptFrom(parent, relativeRepository, 'HEAD');

        expect(result.status).toBe(0);
    });

    test('Should refuse a ref that git would read as an option', () => {
        commitSource(APP_CSP_DIRECTIVES);
        const result = runScript(repository, '--output=drift-output');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--output=drift-output');
        expect(git('status', '--porcelain')).toBe('');
    });

    test('Should print its usage without a checkout path', () => {
        const result = runScript();

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Usage');
    });
});
