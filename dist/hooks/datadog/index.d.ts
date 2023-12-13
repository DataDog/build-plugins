import { BuildPlugin } from '../../webpack';
import { DDHooksContext, MetricToSend } from './types';
export declare const hooks: {
    preoutput: (this: BuildPlugin, { report, bundler }: DDHooksContext) => Promise<{
        metrics: MetricToSend[];
    }>;
    postoutput: (this: BuildPlugin, { start, metrics }: DDHooksContext) => Promise<{
        metrics: MetricToSend[];
    } | undefined>;
};
