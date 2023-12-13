import { Report, LocalModule, TimingsMap, BundlerStats } from '../../../types';
import { Metric } from '../types';
interface GeneralReport {
    modules?: number;
    chunks?: number;
    assets?: number;
    errors?: number;
    warnings?: number;
    entries?: number;
    duration?: number;
}
export declare const getGeneralReport: (report: Report, bundler: BundlerStats) => GeneralReport;
export declare const getGenerals: (report: GeneralReport) => Metric[];
export declare const getDependencies: (modules: LocalModule[]) => Metric[];
export declare const getPlugins: (plugins: TimingsMap) => Metric[];
export declare const getLoaders: (loaders: TimingsMap) => Metric[];
export {};
