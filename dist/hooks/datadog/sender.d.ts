import { MetricToSend } from './types';
interface SenderOptions {
    apiKey: string;
    endPoint: string;
}
export declare const sendMetrics: (metrics: MetricToSend[], opts: SenderOptions) => Promise<unknown>;
export {};
