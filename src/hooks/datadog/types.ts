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

export type Filter = (metric: Metric) => Metric | null;

export interface OptionsInput {
    apiKey: string;
    tags?: string[];
    endPoint?: string;
    prefix?: string;
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

export interface DDHooksContext extends HooksContext {
    metrics: MetricToSend[];
}
