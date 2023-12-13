import { Metric, Options, MetricToSend } from './types';
export declare const defaultFilters: ((metric: Metric) => Metric | null)[];
export declare const getMetric: (metric: Metric, opts: Options) => MetricToSend;
export declare const flattened: (arr: any[]) => never[];
export declare const getType: (name: string) => string | undefined;
