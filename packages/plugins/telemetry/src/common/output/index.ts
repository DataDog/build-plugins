// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';

import type { BundlerContext, TelemetryOptions } from '../../types';
import { getOptionsDD } from '../helpers';

import { outputFiles } from './files';
import { addMetrics, processMetrics } from './metrics';
import { outputTexts } from './text';

export const output = async (
    bundlerContext: BundlerContext,
    options: TelemetryOptions,
    logger: Logger,
    cwd: string,
) => {
    const outputOptions = options.output;
    const optionsDD = getOptionsDD(options);

    addMetrics(bundlerContext, optionsDD, logger, cwd);
    outputTexts(bundlerContext, outputOptions);
    // TODO Handle defaults earlier (outputOptions || true).
    await outputFiles(bundlerContext, outputOptions || true, logger, cwd);
    await processMetrics(bundlerContext, optionsDD, logger);
};
