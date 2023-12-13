import { BuildPlugin } from '../webpack';
import { HooksContext, Stats, EsbuildStats } from '../types';
export declare const outputWebpack: (stats: Stats) => void;
export declare const outputEsbuild: (stats: EsbuildStats) => void;
export declare const hooks: {
    output(this: BuildPlugin, { report, bundler }: HooksContext): Promise<void>;
};
