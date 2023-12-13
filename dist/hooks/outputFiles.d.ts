import { HooksContext } from '../types';
import { BuildPlugin } from '../webpack';
export declare const hooks: {
    output: (this: BuildPlugin, { report, metrics, bundler }: HooksContext) => Promise<void>;
};
