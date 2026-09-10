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

    it('never echoes a real secret value into the parse-error message', async () => {
        // V8's own JSON.parse error embeds a slice of the source text around an unquoted token
        // (e.g. `..."API_KEY": sk_live_ab"...` for a real credential) — this file writes an
        // unquoted token on purpose to trigger that same parse-error shape. Deliberately NOT
        // shaped like a real provider key (no digits, no mixed case, no known prefix): GitHub's
        // own secret scanning blocked this exact commit twice already for using key-shaped
        // fixtures (`sk_live_...`, then `sk_test_...`) even though neither was a real credential.
        const secret = 'THIS_TOKEN_MUST_NEVER_LEAK_INTO_ANY_ERROR_MESSAGE';
        await fs.writeFile(
            path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME),
            `{"STRIPE_API_KEY": ${secret}}`,
        );

        let thrown: unknown;
        try {
            await resolveCustomCredentials(projectRoot);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        if (!(thrown instanceof Error)) {
            throw thrown;
        }
        expect(thrown.message).not.toContain(secret);
        expect(thrown.message).not.toContain(secret.slice(0, 10));
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

    it('resolves a credential literally named "__proto__" instead of silently dropping it', async () => {
        // A plain {} target makes `resolved['__proto__'] = value` hit Object.prototype's own
        // __proto__ setter, which no-ops for a non-object value — the credential just vanishes
        // with no error. Object.create(null) avoids the setter entirely.
        // Written as a raw string, not an object-literal + JSON.stringify: `{ __proto__: ... }`
        // in JS source is special-cased by the *object literal* grammar to set the prototype
        // (a no-op here, since the value's a string) rather than create an own property, so
        // JSON.stringify would silently drop it before this test ever exercises the resolver.
        // JSON.parse has no such special case — "__proto__" is a completely ordinary key there.
        await fs.writeFile(
            path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME),
            '{"__proto__": "sk_test_proto", "STRIPE_API_KEY": "sk_test_123"}',
        );

        // Bracket access via a variable key, not `resolved.__proto__`, since the latter triggers
        // eslint's no-proto rule even though this is reading an ordinary data property here.
        const protoKey = '__proto__';
        const resolved = await resolveCustomCredentials(projectRoot);
        expect(Object.prototype.hasOwnProperty.call(resolved, protoKey)).toBe(true);
        expect(resolved[protoKey]).toBe('sk_test_proto');
        expect(resolved.STRIPE_API_KEY).toBe('sk_test_123');
    });

    it('propagates a non-ENOENT filesystem error instead of treating it as "missing"', async () => {
        // A directory where a file is expected fails to read with EISDIR, not ENOENT — resolving
        // to {} here would hide a real misconfiguration (e.g. a stray directory shadowing the file).
        await fs.mkdir(path.join(projectRoot, CUSTOM_CREDENTIALS_LOCAL_FILENAME));

        await expect(resolveCustomCredentials(projectRoot)).rejects.toThrow();
    });
});
