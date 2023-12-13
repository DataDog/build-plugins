import { Report, BundlerStats } from '../../types';
import { MetricToSend, GetMetricsOptions } from './types';
export declare const getMetrics: (opts: GetMetricsOptions, report: Report, bundler: BundlerStats) => MetricToSend[];
