// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const NAME = 'build-plugins';

if (!process.env.PROJECT_CWD) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}
export const ROOT = process.env.PROJECT_CWD!;

export const IMPORTS_KEY = '// #imports-injection-marker';
export const TYPES_KEY = '// #types-injection-marker';
export const TYPES_EXPORT_KEY = '// #types-export-injection-marker';
export const INTERNAL_PLUGINS_KEY = '// #internal-plugins-injection-marker';
export const INTERNAL_PLUGINS_LIST = '<!-- #internal-plugins-list -->';
export const CONFIGS_KEY = '// #configs-injection-marker';
export const HELPERS_KEY = '// #helpers-injection-marker';
export const MD_PLUGINS_KEY = '<!-- #list-of-packages -->';
export const MD_HOOKS_KEY = '<!-- #list-of-hooks -->';
export const MD_BUNDLERS_KEY = '<!-- #list-of-bundlers -->';
export const MD_TOC_KEY = '<!-- #toc -->';
export const MD_TOC_OMIT_KEY = '<!-- #omit in toc -->';
export const MD_CONFIGURATION_KEY = '<!-- #full-configuration -->';
export const MD_GLOBAL_CONTEXT_KEY = '<!-- #global-context-type -->';
