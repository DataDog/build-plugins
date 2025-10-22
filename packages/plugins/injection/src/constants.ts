// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const PLUGIN_NAME = 'datadog-injection-plugin';
export const DISTANT_FILE_RX = /^https?:\/\//;
export const BEFORE_INJECTION = `// begin injection by Datadog build plugins`;
export const AFTER_INJECTION = `// end injection by Datadog build plugins`;
export const SUPPORTED_EXTENSIONS = ['.mjs', '.mjsx', '.js', '.ts', '.tsx', '.jsx'];
