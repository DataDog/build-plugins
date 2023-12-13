import { PluginBuild, Plugin } from 'esbuild';
import { BaseClass } from '../BaseClass';
import { Options } from '../types';
export declare class BuildPluginClass extends BaseClass {
    constructor(opts: Options);
    setup(build: PluginBuild): void;
}
export declare const BuildPlugin: (opts?: Options) => Plugin;
