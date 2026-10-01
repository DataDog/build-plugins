// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { loadEnvFileCredentials } from '@dd/apps-plugin/vite/dotenv-credentials';
import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
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

describe('Apps Plugin - loadEnvFileCredentials', () => {
    let envDir: string;
    let seedCount = 0;

    const writeEnvFile = (name: string, contents: string) => {
        const envFilePath = path.join(envDir, name);
        outputFileSync(envFilePath, contents);
    };
    const load = (envPrefix?: string | string[]) =>
        loadEnvFileCredentials(loadEnv, { mode: 'development', envDir, envPrefix });

    beforeEach(() => {
        seedCount += 1;
        const startedAt = Date.now();
        envDir = getTempWorkingDir(`dd-apps-dotenv-${startedAt}-${seedCount}`);
    });

    afterEach(() => {
        loadEnvFileCredentials(loadEnv, { mode: 'development', envDir: false });
        for (const key of KEYS) {
            delete process.env[key];
        }
        rmSync(envDir);
    });

    test('Should copy an unprefixed .env value into process.env and return its name', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');

        const result = load();

        expect(result).toEqual({ loaded: ['QA_DOTENV_STRIPE_KEY'], ignoredDatadogKeys: [] });
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
        });
        expect(process.env).not.toHaveProperty('DD_QA_DOTENV_SITE');
        expect(process.env).not.toHaveProperty('DATADOG_QA_DOTENV_KEY');
    });

    // process.env is case-insensitive on Windows, so dd_api_key would be read back as DD_API_KEY.
    test('Should ignore Datadog settings whatever their case', () => {
        writeEnvFile('.env', 'dd_qa_dotenv_lower=from-dotenv\n');

        const result = load();

        expect(result).toEqual({ loaded: [], ignoredDatadogKeys: ['dd_qa_dotenv_lower'] });
        expect(process.env).not.toHaveProperty('dd_qa_dotenv_lower');
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
            copy.loadEnvFileCredentials(loadEnv, { mode: 'development', envDir });
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

    test('Should load nothing and drop earlier values when env files are disabled', () => {
        writeEnvFile('.env', 'QA_DOTENV_STRIPE_KEY=from-dotenv\n');
        load();

        const result = loadEnvFileCredentials(loadEnv, { mode: 'development', envDir: false });

        expect(result).toEqual({ loaded: [], ignoredDatadogKeys: [] });
        expect(process.env).not.toHaveProperty('QA_DOTENV_STRIPE_KEY');
    });
});
