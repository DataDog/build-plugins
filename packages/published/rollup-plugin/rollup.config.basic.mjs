// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDefaultBuildConfigs } from '@dd/tools/rollupConfig.mjs';

import packageJson from './package.json' with { type: 'json' };

export default getDefaultBuildConfigs(packageJson, { basic: true });
