// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command, Option } from 'clipanion';

import { DEFAULT_VITE_CONFIG_PATH } from './config';

const CATEGORY = 'Datadog Apps';

class AppsSecretsCreate extends Command {
    static paths = [['apps-secrets', 'create']];

    static usage = Command.Usage({
        category: CATEGORY,
        description: `Create a Custom Credentials secret store connection for Datadog Apps.`,
        details: `
            Creates a new secret store (a "Custom Credentials" connection) and makes it
            available to every backend function of the app, without needing to reference
            its connection id from code.

            Secret values are never accepted as command arguments — pass the secret
            names with --name and you'll be prompted for each value interactively.

            The new connection id is added to "apps.secretConnections" in your Vite
            config file automatically.
        `,
        examples: [
            [
                `Create a secret store with two secrets`,
                `$0 apps-secrets create --name STRIPE_API_KEY --name OTHER_KEY`,
            ],
        ],
    });

    names: string[] = Option.Array('--name', [], {
        description: 'Name of a secret to add (you will be prompted for its value).',
    });
    connectionName?: string = Option.String('--connection-name', {
        description: 'Human-readable name for the connection. Defaults to the package name.',
    });
    config: string = Option.String('--config', DEFAULT_VITE_CONFIG_PATH, {
        description: 'Path to the Vite config file to update with the new connection id.',
    });

    async execute() {
        const { getConnectionsClient } = await import('@dd/apps-plugin/connections');
        const { readFileSync } = await import('@dd/core/helpers/fs');
        const { resolveAuth } = await import('./auth');
        const { promptSecretValues } = await import('./ask');
        const { readSecretConnections, writeSecretConnections } = await import('./config');
        const { green, red } = await import('../../helpers');

        if (!this.names.length) {
            console.log(red('Pass at least one --name to create a secret.'));
            return 1;
        }

        const connectionName =
            this.connectionName ||
            (() => {
                try {
                    const pkg = JSON.parse(readFileSync('package.json'));
                    return pkg.name ? `${pkg.name} secrets` : 'Custom Credentials secrets';
                } catch {
                    return 'Custom Credentials secrets';
                }
            })();

        const { auth, site } = resolveAuth();
        const client = getConnectionsClient(auth, site);

        const tokens = await promptSecretValues(this.names);
        const connectionId = await client.createSecretStore(connectionName, tokens);

        const existing = await readSecretConnections(this.config);
        await writeSecretConnections(this.config, [...new Set([...existing, connectionId])]);

        console.log(
            `${green('Created secret store')} ${green(connectionId)} and added it to ${green(this.config)}.`,
        );
    }
}

class AppsSecretsSet extends Command {
    static paths = [['apps-secrets', 'set']];

    static usage = Command.Usage({
        category: CATEGORY,
        description: `Add, update, or remove secrets on an existing secret store connection.`,
        details: `
            Reads the current secret names on the connection, drops any name passed to
            --remove, prompts for a new value for each name passed to --name, then writes
            the full merged set back. Secrets not mentioned are left untouched.

            The connection id can be omitted when your Vite config has exactly one entry
            in "apps.secretConnections".
        `,
        examples: [
            [`Rotate one secret`, `$0 apps-secrets set --name STRIPE_API_KEY`],
            [`Remove a secret`, `$0 apps-secrets set --remove OLD_KEY`],
        ],
    });

    connectionId?: string = Option.String({ required: false });
    names: string[] = Option.Array('--name', [], {
        description: 'Name of a secret to add or update (you will be prompted for its value).',
    });
    removeNames: string[] = Option.Array('--remove', [], {
        description: 'Name of a secret to remove from the connection.',
    });
    config: string = Option.String('--config', DEFAULT_VITE_CONFIG_PATH, {
        description: 'Path to the Vite config file to read the connection id from.',
    });

    async execute() {
        const { getConnectionsClient } = await import('@dd/apps-plugin/connections');
        const { resolveAuth } = await import('./auth');
        const { promptSecretValues } = await import('./ask');
        const { resolveConnectionId } = await import('./config');
        const { green } = await import('../../helpers');

        const connectionId = await resolveConnectionId(this.connectionId, this.config);
        const { auth, site } = resolveAuth();
        const client = getConnectionsClient(auth, site);

        const current = await client.getSecretStore(connectionId);
        const removeSet = new Set(this.removeNames);
        const changedSet = new Set(this.names);
        const unchanged = current.tokens.filter(
            (token) => !removeSet.has(token.name) && !changedSet.has(token.name),
        );

        // A SECRET-kind token with no ref means the API returned it without a way to
        // carry its value forward unchanged (see connections.ts's fromRawToken) — we
        // can't silently resend it, so make the caller decide explicitly.
        const unresolvable = unchanged.filter((token) => token.kind === 'SECRET' && !token.ref);
        if (unresolvable.length) {
            throw new Error(
                `Cannot leave these secrets unchanged (no value reference returned by the API): ` +
                    `${unresolvable.map((t) => t.name).join(', ')}. Pass them to --name to set a new value, or --remove to delete them.`,
            );
        }

        const changed = await promptSecretValues(this.names);

        await client.updateSecretStore(connectionId, [...unchanged, ...changed]);

        console.log(`${green('Updated secret store')} ${green(connectionId)}.`);
    }
}

class AppsSecretsDelete extends Command {
    static paths = [['apps-secrets', 'delete']];

    static usage = Command.Usage({
        category: CATEGORY,
        description: `Delete a secret store connection.`,
        details: `
            Deletes the connection from Datadog and removes it from
            "apps.secretConnections" in your Vite config file.

            The connection id can be omitted when your Vite config has exactly one entry
            in "apps.secretConnections".
        `,
        examples: [[`Delete the configured secret store`, `$0 apps-secrets delete`]],
    });

    connectionId?: string = Option.String({ required: false });
    config: string = Option.String('--config', DEFAULT_VITE_CONFIG_PATH, {
        description: 'Path to the Vite config file to remove the connection id from.',
    });

    async execute() {
        const { getConnectionsClient } = await import('@dd/apps-plugin/connections');
        const { resolveAuth } = await import('./auth');
        const { readSecretConnections, writeSecretConnections, resolveConnectionId } = await import(
            './config'
        );
        const { green } = await import('../../helpers');

        const connectionId = await resolveConnectionId(this.connectionId, this.config);
        const { auth, site } = resolveAuth();

        await getConnectionsClient(auth, site).deleteSecretStore(connectionId);

        const existing = await readSecretConnections(this.config);
        await writeSecretConnections(
            this.config,
            existing.filter((id) => id !== connectionId),
        );

        console.log(`${green('Deleted secret store')} ${green(connectionId)}.`);
    }
}

class AppsSecretsList extends Command {
    static paths = [['apps-secrets', 'list']];

    static usage = Command.Usage({
        category: CATEGORY,
        description: `List secret store connections and their secret names.`,
        details: `
            Never prints secret values — only names, which is all the API returns once a
            secret has been stored.
        `,
        examples: [[`List all configured secret stores`, `$0 apps-secrets list`]],
    });

    connectionId?: string = Option.String({ required: false });
    config: string = Option.String('--config', DEFAULT_VITE_CONFIG_PATH, {
        description: 'Path to the Vite config file to read connection ids from.',
    });

    async execute() {
        const { getConnectionsClient } = await import('@dd/apps-plugin/connections');
        const { resolveAuth } = await import('./auth');
        const { readSecretConnections } = await import('./config');
        const { green, dim } = await import('../../helpers');

        const ids = this.connectionId
            ? [this.connectionId]
            : await readSecretConnections(this.config);

        if (!ids.length) {
            console.log(dim(`No secret store connections found in ${this.config}.`));
            return;
        }

        const { auth, site } = resolveAuth();
        const client = getConnectionsClient(auth, site);

        for (const id of ids) {
            const store = await client.getSecretStore(id);
            console.log(`${green(store.name)} ${dim(`(${id})`)}`);
            for (const token of store.tokens) {
                console.log(`  - ${token.name}`);
            }
        }
    }
}

export default [AppsSecretsCreate, AppsSecretsSet, AppsSecretsDelete, AppsSecretsList];
