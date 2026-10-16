// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    dropEnvFileCredentials,
    loadEnvFileCredentials,
    PROCESS_SETTING_KEYS,
} from '@dd/apps-plugin/vite/dotenv-credentials';
import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import os from 'os';
import path from 'path';
import { loadEnv } from 'vite';

const KEYS = [
    'QA_DOTENV_STRIPE_KEY',
    'QA_DOTENV_OTHER_KEY',
    'VITE_QA_DOTENV_PUBLIC',
    'PUBLIC_QA_DOTENV',
    'B_QA_DOTENV',
    'DD_QA_DOTENV_SITE',
    'DATADOG_QA_DOTENV_KEY',
    'dd_qa_dotenv_lower',
];

// One sample per rule, skipping any the shell running the tests already sets.
const PROCESS_SETTING_SAMPLES = [
    ...PROCESS_SETTING_KEYS.prefixes.flatMap((prefix) => [
        `${prefix}QA_DOTENV`,
        `${prefix.toLowerCase()}qa_dotenv`,
    ]),
    ...PROCESS_SETTING_KEYS.names.flatMap((name) => [name, name.toLowerCase()]),
    ...PROCESS_SETTING_KEYS.infixes.map((infix) => `QA${infix}DOTENV`),
    ...PROCESS_SETTING_KEYS.suffixes.map((suffix) => `qa_dotenv${suffix.toLowerCase()}`),
].filter((key) => !(key in process.env));
const LOOKALIKE_KEYS = [
    'QA_DOTENV_CACHE_DIR',
    'QA_DOTENV_PATHS',
    'QA_DOTENV_TZ_NAME',
    'QA_DOTENV_NODE',
];

const isAlwaysActive = () => true;

describe('Apps Plugin - loadEnvFileCredentials', () => {
    let envDir: string;
    let otherRoots: string[] = [];
    let seedCount = 0;

    const writeEnvFile = (name: string, contents: string) => {
        const envFilePath = path.join(envDir, name);
        outputFileSync(envFilePath, contents);
    };
    const load = (envPrefix?: string | string[]) =>
        loadEnvFileCredentials(
            loadEnv,
            { root: envDir, mode: 'development', envDir, envPrefix },
            isAlwaysActive,
        );
    const createOtherRoot = (name: string, envContents: string) => {
        const startedAt = Date.now();
        const root = getTempWorkingDir(`dd-apps-dotenv-${name}-${startedAt}-${seedCount}`);
        otherRoots.push(root);
        const envFilePath = path.join(root, '.env');
        outputFileSync(envFilePath, envContents);
        const loadOtherRoot = () =>
            loadEnvFileCredentials(
                loadEnv,
                { root, mode: 'development', envDir: root },
                isAlwaysActive,
            );
        return { envFilePath, load: loadOtherRoot };
    };

    beforeEach(() => {
        seedCount += 1;
        const startedAt = Date.now();
        envDir = getTempWorkingDir(`dd-apps-dotenv-${startedAt}-${seedCount}`);
    });

    afterEach(() => {
        dropEnvFileCredentials();
        for (const key of [...KEYS, ...PROCESS_SETTING_SAMPLES, ...LOOKALIKE_KEYS]) {
            delete process.env[key];
        }
        rmSync(envDir);
        for (const root of otherRoots) {
            rmSync(root);
        }
        otherRoots = [];
    });

    test('Should copy an unprefixed .env value into process.env and return its name', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');

        const result = load();

        expect(result).toEqual({
            loaded: ['QA_DOTENV_STRIPE_KEY'],
            ignoredDatadogKeys: [],
            ignoredProcessKeys: [],
            shadowedKeys: [],
            drop: expect.any(Function),
        });
        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('from-dotenv');
    });

    test('Should let a shell variable take precedence over the .env value', () => {
        process.env.QA_DOTENV_STRIPE_KEY = 'from-shell';
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');

        const result = load();

        expect(result.loaded).toEqual([]);
        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('from-shell');
    });

    test.each([
        { files: { '.env.local': 'QA_DOTENV_STRIPE_KEY=local' }, expected: 'local' },
        { files: { '.env.development': 'QA_DOTENV_STRIPE_KEY=mode' }, expected: 'mode' },
        {
            files: {
                '.env.development': 'QA_DOTENV_STRIPE_KEY=mode',
                '.env.development.local': 'QA_DOTENV_STRIPE_KEY=mode-local',
            },
            expected: 'mode-local',
        },
    ])('Should follow Vite env file precedence ($expected)', ({ files, expected }) => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=base\n');
        for (const [name, contents] of Object.entries(files)) {
            writeEnvFile(name, `${contents}\n`);
        }

        load();

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe(expected);
    });

    // Vite's own loadEnv prefers process.env over the file, so a copied public key would go stale.
    test.each([
        { envPrefix: undefined, key: 'VITE_QA_DOTENV_PUBLIC' },
        { envPrefix: 'PUBLIC_', key: 'PUBLIC_QA_DOTENV' },
        { envPrefix: ['A_', 'B_'], key: 'B_QA_DOTENV' },
    ])('Should leave a key with Vite envPrefix $envPrefix to Vite', ({ envPrefix, key }) => {
        writeEnvFile('.env', `${key}=public\nQA_DOTENV_STRIPE_KEY=from-dotenv\n`);

        const result = load(envPrefix);

        expect(result.loaded).toEqual(['QA_DOTENV_STRIPE_KEY']);
        expect(process.env).not.toHaveProperty(key);
    });

    test('Should ignore Datadog settings in .env files and report their names', () => {
        writeEnvFile(
            '.env',
            'DD_QA_DOTENV_SITE=datadoghq.eu\nDATADOG_QA_DOTENV_KEY=from-dotenv\nQA_DOTENV_STRIPE_KEY=from-dotenv\n',
        );

        const result = load();

        expect(result).toEqual({
            loaded: ['QA_DOTENV_STRIPE_KEY'],
            ignoredDatadogKeys: ['DD_QA_DOTENV_SITE', 'DATADOG_QA_DOTENV_KEY'],
            ignoredProcessKeys: [],
            shadowedKeys: [],
            drop: expect.any(Function),
        });
        expect(process.env).not.toHaveProperty('DD_QA_DOTENV_SITE');
        expect(process.env).not.toHaveProperty('DATADOG_QA_DOTENV_KEY');
    });

    // process.env is case-insensitive on Windows, so dd_api_key would be read back as DD_API_KEY.
    test('Should ignore Datadog settings whatever their case', () => {
        writeEnvFile('.env', 'dd_qa_dotenv_lower=from-dotenv\n');

        const result = load();

        expect(result).toEqual({
            loaded: [],
            ignoredDatadogKeys: ['dd_qa_dotenv_lower'],
            ignoredProcessKeys: [],
            shadowedKeys: [],
            drop: expect.any(Function),
        });
        expect(process.env).not.toHaveProperty('dd_qa_dotenv_lower');
    });

    test('Should ignore NODE_TLS_REJECT_UNAUTHORIZED, which would turn off TLS checks for the whole process', () => {
        const shellValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        writeEnvFile('.env', 'NODE_TLS_REJECT_UNAUTHORIZED=0\nQA_DOTENV_STRIPE_KEY=from-dotenv\n');

        try {
            const result = load();

            expect(result).toEqual({
                loaded: ['QA_DOTENV_STRIPE_KEY'],
                ignoredDatadogKeys: [],
                ignoredProcessKeys: ['NODE_TLS_REJECT_UNAUTHORIZED'],
                shadowedKeys: [],
                drop: expect.any(Function),
            });
            expect(process.env).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED');
        } finally {
            if (shellValue !== undefined) {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = shellValue;
            }
        }
    });

    test('Should ignore every key that changes Node or process behavior, whatever its case', () => {
        const contents = PROCESS_SETTING_SAMPLES.map((key) => `${key}=from-dotenv`).join('\n');
        writeEnvFile('.env', `${contents}\nQA_DOTENV_STRIPE_KEY=from-dotenv\n`);

        const result = load();
        const leakedKeys = PROCESS_SETTING_SAMPLES.filter((key) => key in process.env);

        expect(result.loaded).toEqual(['QA_DOTENV_STRIPE_KEY']);
        expect(result.ignoredProcessKeys).toEqual(PROCESS_SETTING_SAMPLES);
        expect(leakedKeys).toEqual([]);
    });

    // os.tmpdir() falls back to TMP and TEMP when TMPDIR is unset, as it usually is on Linux.
    test('Should leave os.tmpdir() to the shell when TMPDIR is unset', () => {
        const shellTmpDir = process.env.TMPDIR;
        const shellTmp = process.env.TMP;
        const shellTemp = process.env.TEMP;
        delete process.env.TMPDIR;
        delete process.env.TMP;
        delete process.env.TEMP;
        const defaultTmpDir = os.tmpdir();
        writeEnvFile('.env', 'TMP=/qa-dotenv-tmp\nTEMP=/qa-dotenv-temp\n');

        try {
            const result = load();
            const tmpDirAfterLoad = os.tmpdir();

            expect(result.ignoredProcessKeys).toEqual(['TMP', 'TEMP']);
            expect(tmpDirAfterLoad).toBe(defaultTmpDir);
        } finally {
            const shellValues = { TMPDIR: shellTmpDir, TMP: shellTmp, TEMP: shellTemp };
            for (const [key, value] of Object.entries(shellValues)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    test.each(LOOKALIKE_KEYS)('Should load %s, which only resembles a process setting', (key) => {
        writeEnvFile('.env', `${key}=from-dotenv\n`);

        const result = load();

        expect(result.loaded).toEqual([key]);
        expect(process.env[key]).toBe('from-dotenv');
    });

    test('Should pick up edited and removed .env values when it runs again after a server restart', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=first\nQA_DOTENV_OTHER_KEY=removed-later\n');
        load();

        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=second\n');
        const result = load();

        expect(result.loaded).toEqual(['QA_DOTENV_STRIPE_KEY']);
        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('second');
        expect(process.env).not.toHaveProperty('QA_DOTENV_OTHER_KEY');
    });

    // Vite bundles a config's non-node_modules imports, so a restart can load a second copy.
    test('Should pick up an edited .env value when a restart loads a separate copy of this module', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=first\n');
        load();

        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=second\n');
        jest.isolateModules(() => {
            const copy: typeof import('./dotenv-credentials') = require('./dotenv-credentials');
            copy.loadEnvFileCredentials(
                loadEnv,
                { root: envDir, mode: 'development', envDir },
                isAlwaysActive,
            );
        });

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('second');
    });

    test('Should keep a value that something else set after the .env file was loaded', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');
        load();
        process.env.QA_DOTENV_STRIPE_KEY = 'set-later';

        load();

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('set-later');
    });

    test('Should drop values from the previous load and keep shell variables', () => {
        process.env.QA_DOTENV_OTHER_KEY = 'from-shell';
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\nQA_DOTENV_OTHER_KEY=from-dotenv\n');
        load();

        dropEnvFileCredentials();

        expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
        expect(process.env.QA_DOTENV_OTHER_KEY).toBe('from-shell');
    });

    test('Should load nothing and drop earlier values when env files are disabled', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');
        load();

        const result = loadEnvFileCredentials(
            loadEnv,
            {
                root: envDir,
                mode: 'development',
                envDir: false,
            },
            isAlwaysActive,
        );

        expect(result).toEqual({
            loaded: [],
            ignoredDatadogKeys: [],
            ignoredProcessKeys: [],
            shadowedKeys: [],
            drop: expect.any(Function),
        });
        expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
    });

    test('Should drop only the values loaded for the same project root', () => {
        const otherRoot = createOtherRoot('other', 'QA_DOTENV_OTHER_KEY=other-root\n');
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=first\n');

        load();
        otherRoot.load();
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=second\n');
        load();

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('second');
        expect(process.env.QA_DOTENV_OTHER_KEY).toBe('other-root');

        outputFileSync(otherRoot.envFilePath, 'QA_DOTENV_OTHER_KEY=other-root-edited\n');
        otherRoot.load();

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('second');
        expect(process.env.QA_DOTENV_OTHER_KEY).toBe('other-root-edited');
    });

    test("Should keep another root's values when one load is dropped", () => {
        const otherRoot = createOtherRoot('drop-other', 'QA_DOTENV_OTHER_KEY=other-root\n');
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');

        const result = load();
        otherRoot.load();
        result.drop();

        expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
        expect(process.env.QA_DOTENV_OTHER_KEY).toBe('other-root');
    });

    const sharedKeyCases = [
        {
            description: 'its own value',
            otherValue: 'second',
            shadowedKeys: ['QA_DOTENV_STRIPE_KEY'],
        },
        { description: 'the same value', otherValue: 'first', shadowedKeys: [] },
    ];
    test.each(sharedKeyCases)(
        'Should hand a key to another open root that defines it with $description once the owning root ends',
        ({ otherValue, shadowedKeys }) => {
            const otherRoot = createOtherRoot('shared', `QA_DOTENV_STRIPE_KEY=${otherValue}\n`);
            writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=first\n');

            const ownerResult = load();
            const otherResult = otherRoot.load();
            const whileOwnerOpen = process.env.QA_DOTENV_STRIPE_KEY;
            ownerResult.drop();
            const afterOwnerDropped = process.env.QA_DOTENV_STRIPE_KEY;
            otherResult.drop();

            expect(otherResult.loaded).toEqual([]);
            expect(otherResult.shadowedKeys).toEqual(shadowedKeys);
            expect(whileOwnerOpen).toBe('first');
            expect(afterOwnerDropped).toBe(otherValue);
            expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
        },
    );

    test("Should hand a key to another open root when the owning root's .env no longer defines it", () => {
        const otherRoot = createOtherRoot('shared-removed', 'QA_DOTENV_STRIPE_KEY=second\n');
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=first\n');
        load();
        otherRoot.load();

        writeEnvFile('.env', 'QA_DOTENV_OTHER_KEY=unrelated\n');
        load();

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('second');
    });

    test('Should keep a value that something else set instead of handing it to another root', () => {
        const otherRoot = createOtherRoot('shared-set-later', 'QA_DOTENV_STRIPE_KEY=second\n');
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=first\n');
        const ownerResult = load();
        const otherResult = otherRoot.load();
        process.env.QA_DOTENV_STRIPE_KEY = 'set-later';

        ownerResult.drop();
        const afterOwnerDropped = process.env.QA_DOTENV_STRIPE_KEY;
        otherResult.drop();

        expect(afterOwnerDropped).toBe('set-later');
        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('set-later');
    });

    test("Should drop a root's values once its other loads report they ended", () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');
        let isEarlierLoadActive = true;
        const config = { root: envDir, mode: 'development', envDir };
        loadEnvFileCredentials(loadEnv, config, () => isEarlierLoadActive);
        const laterResult = load();

        isEarlierLoadActive = false;
        laterResult.drop();

        expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
    });

    test('Should keep a later load for the same root when an earlier load is dropped', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=unchanged\n');
        const earlierResult = load();
        load();

        earlierResult.drop();

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('unchanged');
    });

    test("Should keep a root's values until every load for it is dropped", () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');
        const earlierResult = load();
        const laterResult = load();

        laterResult.drop();
        const keptWhileEarlierLoadOpen = process.env.QA_DOTENV_STRIPE_KEY;
        earlierResult.drop();

        expect(keptWhileEarlierLoadOpen).toBe('from-dotenv');
        expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
    });

    test('Should drop the next load for the root when an earlier load failed to read the files', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');
        const failingLoadEnv: typeof loadEnv = () => {
            throw new Error('unreadable .env file');
        };
        const failingLoad = () =>
            loadEnvFileCredentials(
                failingLoadEnv,
                { root: envDir, mode: 'development', envDir },
                isAlwaysActive,
            );

        expect(failingLoad).toThrow('unreadable .env file');
        const result = load();
        result.drop();

        expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
    });

    test("Should keep the previous load's values when reading the files fails", () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');
        const result = load();
        const failingLoadEnv: typeof loadEnv = () => {
            throw new Error('unreadable .env file');
        };
        const failingLoad = () =>
            loadEnvFileCredentials(
                failingLoadEnv,
                { root: envDir, mode: 'development', envDir },
                isAlwaysActive,
            );

        expect(failingLoad).toThrow('unreadable .env file');
        const keptAfterFailure = process.env.QA_DOTENV_STRIPE_KEY;
        result.drop();

        expect(keptAfterFailure).toBe('from-dotenv');
        expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
    });

    test("Should expand a root's variable references with its own values, not another root's", () => {
        const otherRoot = createOtherRoot('expand', 'QA_DOTENV_OTHER_KEY=other-root\n');
        writeEnvFile(
            '.env',
            `QA_DOTENV_OTHER_KEY=own\nQA_DOTENV_STRIPE_KEY=https://\${QA_DOTENV_OTHER_KEY}/api\n`,
        );

        otherRoot.load();
        load();

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('https://own/api');
    });

    test('Should keep a value that something else set when its load is dropped', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');
        const result = load();
        process.env.QA_DOTENV_STRIPE_KEY = 'set-later';

        result.drop();

        expect(process.env.QA_DOTENV_STRIPE_KEY).toBe('set-later');
    });
});
