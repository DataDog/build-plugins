// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ESLint, Linter, Rule } from 'eslint';

import validConnectionsFile from './rules/valid-connections-file';

const PLUGIN_NAME = 'apps';
const PLUGIN_PACKAGE = '@datadog/eslint-plugin-apps';
const VERSION = '3.1.4';

const rules: Record<string, Rule.RuleModule> = {
    'valid-connections-file': validConnectionsFile,
};

interface AppsPlugin extends ESLint.Plugin {
    meta: { name: string; version: string };
    rules: Record<string, Rule.RuleModule>;
    configs: {
        recommended: Linter.Config[];
        'recommended-legacy': Linter.LegacyConfig;
    };
}

const plugin: AppsPlugin = {
    meta: { name: PLUGIN_PACKAGE, version: VERSION },
    rules,
    configs: {
        recommended: [],
        'recommended-legacy': {
            plugins: ['@datadog/apps'],
            rules: {
                '@datadog/apps/valid-connections-file': 'error',
            },
        },
    },
};

plugin.configs.recommended = [
    {
        plugins: { [PLUGIN_NAME]: plugin },
        rules: {
            [`${PLUGIN_NAME}/valid-connections-file`]: 'error',
        },
    },
];

export default plugin;
