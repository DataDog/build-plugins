import type { UserConfig } from 'vite7';
import { build, version } from 'vite7';

import type { BundlerRunFn } from './bundlers';

export const buildWithVite7: BundlerRunFn = async (bundlerConfig: UserConfig) => {
    console.log('VITE VERSION', version);
    const errors = [];
    let result: Awaited<ReturnType<typeof build>> | undefined;

    try {
        result = await build(bundlerConfig);
    } catch (e: any) {
        errors.push(`[VITE] : ${e.message}`);
    }

    return { errors, result };
};
