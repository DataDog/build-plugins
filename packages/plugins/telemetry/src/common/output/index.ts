// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogFn } from '@dd/core/log';

import { CONFIG_KEY, PLUGIN_NAME } from '../../constants';
import type { Context, OptionsWithTelemetry } from '../../types';
import { getOptionsDD } from '../helpers';

import { outputFiles } from './files';
import { addMetrics, processMetrics } from './metrics';
import { outputTexts } from './text';

export const output = async (context: Context, options: OptionsWithTelemetry, cwd: string) => {
    const log = getLogFn(options.logLevel, PLUGIN_NAME);
    const telemetryOptions = options[CONFIG_KEY];
    const outputOptions = telemetryOptions.output;
    const optionsDD = getOptionsDD(telemetryOptions);

    addMetrics(context, optionsDD, log, cwd);
    outputTexts(context, outputOptions);
    // TODO Handle defaults earlier (outputOptions || true).
    await outputFiles(context, outputOptions || true, log, cwd);
    await processMetrics(context, options, log);
};
