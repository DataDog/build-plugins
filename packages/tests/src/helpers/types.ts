import type { BuildOptions } from 'esbuild';
import type { RollupOptions } from 'rollup';
import type { Configuration as Configuration4 } from 'webpack4';
import type { Configuration } from 'webpack';

export type BundlerOverrides = {
    rollup?: Partial<RollupOptions>;
    vite?: Partial<RollupOptions>;
    esbuild?: Partial<BuildOptions>;
    webpack5?: Partial<Configuration>;
    webpack4?: Partial<Configuration4>;
};
