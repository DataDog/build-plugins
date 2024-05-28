// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/*
You should probably not touch this file.
It's mostly filled automatically with new plugins.
*/

import { buildPluginFactory } from '@dd/factory';

export const datadogWebpackPlugin = buildPluginFactory().webpack;

export { helpers } from '@dd/factory';

export type {
    Options as WebpackPluginOptions,
    // #types-export-injection-marker
    TelemetryTypes,
    // #types-export-injection-marker
} from '@dd/factory';
