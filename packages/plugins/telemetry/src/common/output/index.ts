// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';

import type { BundlerContext, TelemetryOptions } from '../../types';
import { getOptionsDD } from '../helpers';

import { outputFiles } from './files';
import { addMetrics, processMetrics } from './metrics';
import { outputTexts } from './text';

export const output = async (
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
    options: TelemetryOptions,
    logger: Logger,
) => {
    const outputOptions = options.output;
    const optionsDD = getOptionsDD(options);

    addMetrics(bundlerContext, globalContext, optionsDD, logger);
    outputTexts(bundlerContext, globalContext, outputOptions);
    // TODO Handle defaults earlier (outputOptions || true)
    // with validateOptions and create a TelemetryOptionsWithDefaults.
    await outputFiles(bundlerContext, outputOptions || true, logger, globalContext.cwd);
    await processMetrics(bundlerContext, optionsDD, logger);
};
