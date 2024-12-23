// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// This file is partially generated.
// Anything between #types-export-injection-marker
// will be updated using the 'yarn cli integrity' command.

import * as factory from '@dd/factory';
import rollup from 'rollup';

import pkg from '../package.json';

export const datadogRollupPlugin = factory.buildPluginFactory({
    bundler: rollup,
    version: pkg.version,
}).rollup;

export type { Options as RollupPluginOptions } from '@dd/core/types';

export type {
    // #types-export-injection-marker
    RumTypes,
    TelemetryTypes,
    // #types-export-injection-marker
} from '@dd/factory';

export const version = pkg.version;
export const helpers = factory.helpers;
