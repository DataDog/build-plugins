// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command, Option } from 'clipanion';

class ResetOAuth extends Command {
    static paths = [['reset-oauth']];

    static usage = Command.Usage({
        category: `Contribution`,
        description: `Clear the cached Datadog Apps OAuth token to restart the authorization flow.`,
        details: `
            OAuth tokens obtained by the Apps plugin are persisted in the OS credential store (keychain).

            This command removes those cached tokens so the next upload triggers a fresh browser authorization.

            By default it clears the token for every known Datadog site. Pass --site to target a single site.
        `,
        examples: [
            [`Reset for all sites`, `$0 reset-oauth`],
            [`Reset for a specific site`, `$0 reset-oauth --site datadoghq.eu`],
        ],
    });

    site = Option.String('--site', {
        description: 'Only clear the token for this Datadog site (e.g. datadoghq.com).',
    });

    async execute() {
        const { SITES } = await import('@dd/core/constants');
        const { deleteOAuthTokenFromKeychain, getDatadogOAuthConfig } = await import(
            '@dd/core/helpers/oauth-request'
        );
        const { green, red, dim } = await import('@dd/tools/helpers');

        const isKnownSite = this.site && SITES.some((site) => site === this.site);
        if (this.site && !isKnownSite) {
            console.error(
                red(`Unknown site "${this.site}". Supported sites: ${SITES.join(', ')}.`),
            );
            return 1;
        }

        const sites = this.site ? [this.site] : [...SITES];
        const errors: string[] = [];

        for (const site of sites) {
            try {
                const options = getDatadogOAuthConfig(site);
                await deleteOAuthTokenFromKeychain(site, options);
                console.log(`  Cleared cached OAuth token for ${green(site)}.`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`[${red('Error')}] ${site} - ${dim(message)}`);
            }
        }

        if (errors.length > 0) {
            console.error(errors.join('\n'));
            throw new Error(
                `Could not clear ${errors.length} OAuth token${errors.length > 1 ? 's' : ''}.`,
            );
        }

        console.log(
            green(`\nDone. The next Datadog Apps upload will start a fresh authorization.`),
        );
        return 0;
    }
}

export default [ResetOAuth];
