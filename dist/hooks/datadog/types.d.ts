import { HooksContext } from '../../types';
export interface MetricToSend {
    type: 'gauge';
    tags: string[];
    metric: string;
    points: [number, number][];
}
export interface Metric {
    metric: string;
    type: 'count' | 'size' | 'duration';
    value: number;
    tags: string[];
}
export declare type Filter = (metric: Metric) => Metric | null;
export interface DatadogOptions {
    apiKey?: string;
    endPoint?: string;
    prefix?: string;
    tags?: string[];
    timestamp?: number;
    filters?: Filter[];
}
export interface Options {
    apiKey: string;
    tags: string[];
    endPoint: string;
    prefix: string;
    timestamp: number;
    filters: Filter[];
}
export interface GetMetricsOptions extends Options {
    context: string;
}
export interface DDHooksContext extends HooksContext {
    metrics: MetricToSend[];
}
