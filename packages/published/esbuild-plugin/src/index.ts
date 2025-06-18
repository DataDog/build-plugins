// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// This file is partially generated.
// Anything between #types-export-injection-marker
// will be updated using the 'yarn cli integrity' command.

import type { Options } from '@dd/core/types';
import type {
    // #types-export-injection-marker
    ErrorTrackingTypes,
    RumTypes,
    PrivacyTypes,
    TelemetryTypes,
    // #types-export-injection-marker
} from '@dd/factory';
import * as factory from '@dd/factory';
import esbuild from 'esbuild';

import pkg from '../package.json';

export type EsbuildPluginOptions = Options;
export type {
    // #types-export-injection-marker
    ErrorTrackingTypes,
    RumTypes,
    PrivacyTypes,
    TelemetryTypes,
    // #types-export-injection-marker
};

export const datadogEsbuildPlugin = factory.buildPluginFactory({
    bundler: esbuild,
    version: pkg.version,
}).esbuild;

export const version = pkg.version;
export const helpers = factory.helpers;
