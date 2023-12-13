import { PluginBuild } from 'esbuild';
import { TimingsMap } from '../types';
export declare const wrapPlugins: (build: PluginBuild, context: string) => void;
export declare const getResults: () => {
    plugins: TimingsMap;
    modules: TimingsMap;
};
