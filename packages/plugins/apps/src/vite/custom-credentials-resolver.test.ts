// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    CUSTOM_CREDENTIALS_LOCAL_FILENAME,
    resolveCustomCredentials,
} from './custom-credentials-resolver';

describe('resolveCustomCredentials', () => {
    let projectRoot: string;

    beforeEach(async () => {
        projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-credentials-resolver-'));
    });

    afterEach(async () => {
        await fs.rm(projectRoot, { recursive: true, force: true });
    });

    it('resolves to {} when the file does not exist', async () => {
        await expect(resolveCustomCredentials(projectRoot)).resolves.toEqual({});
    });

    it('resolves the flat object of env var name to value', async () => {
        await fs.writeFile(
            path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME),
            JSON.stringify({ STRIPE_API_KEY: 'sk_test_123' }),
        );

        await expect(resolveCustomCredentials(projectRoot)).resolves.toEqual({
            STRIPE_API_KEY: 'sk_test_123',
        });
    });

    it('rejects malformed JSON instead of silently returning {}', async () => {
        await fs.writeFile(
            path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME),
            '{ not valid json',
        );

        await expect(resolveCustomCredentials(projectRoot)).rejects.toThrow(/not valid JSON/);
    });

    it('rejects a top-level array', async () => {
        await fs.writeFile(
            path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME),
            JSON.stringify(['STRIPE_API_KEY']),
        );

        await expect(resolveCustomCredentials(projectRoot)).rejects.toThrow(/flat JSON object/);
    });

    it('rejects a non-string value, naming the offending key', async () => {
        await fs.writeFile(
            path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME),
            JSON.stringify({ STRIPE_API_KEY: 12345 }),
        );

        await expect(resolveCustomCredentials(projectRoot)).rejects.toThrow(
            /"STRIPE_API_KEY".*must be a string/,
        );
    });

    it('propagates a non-ENOENT filesystem error instead of treating it as "missing"', async () => {
        // A directory where a file is expected fails to read with EISDIR, not ENOENT — resolving
        // to {} here would hide a real misconfiguration (e.g. a stray directory shadowing the file).
        await fs.mkdir(path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME));

        await expect(resolveCustomCredentials(projectRoot)).rejects.toThrow();
    });
});
