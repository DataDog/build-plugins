export const typesOfPlugin = ['universal', 'bundler'] as const;

export const bundlerHooks = ['webpack', 'esbuild', 'vite', 'rollup', 'rspack', 'farm'] as const;

export const universalHooks = [
    'enforce',
    'buildStart',
    'resolveId',
    'load',
    'transform',
    'watchChange',
    'buildEnd',
    'writeBundle',
] as const;
