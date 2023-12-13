import { Metafile } from 'esbuild';
import { LocalModule } from '../types';
export declare const getModulesResults: (options: Pick<import("../types").Options, "output" | "disabled" | "datadog" | "context">, esbuildMeta?: Metafile | undefined) => {
    [key: string]: LocalModule;
};
