import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'rumPrivacy' as const;
export const PLUGIN_NAME: PluginName = 'datadog-rum-privacy-plugin' as const;
export const PRIVACY_HELPERS_MODULE_ID = 'datadog:privacy-helpers';
