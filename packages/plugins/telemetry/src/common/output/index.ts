import type { Context, OptionsWithTelemetryEnabled } from '../../types';

import { outputFiles } from './files';
import { addMetrics, processMetrics } from './metrics';
import { outputTexts } from './text';

export const output = async (context: Context, options: OptionsWithTelemetryEnabled) => {
    addMetrics(context, options);
    outputTexts(context, options);
    await outputFiles(context, options);
    await processMetrics(context, options);
};
