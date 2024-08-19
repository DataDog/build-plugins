import type { GlobalContext } from '../../types';

export const getType = (name: string): string => {
    if (name === 'unknown') {
        return name;
    }

    if (name.includes('webpack/runtime')) {
        return 'runtime';
    }

    return name.includes('.') ? name.split('.').pop()! : 'unknown';
};

export const cleanName = (context: GlobalContext, filepath: string) => {
    if (filepath === 'unknown') {
        return filepath;
    }

    if (filepath.includes('webpack/runtime')) {
        return filepath.replace('webpack/runtime/', '').replace(/ +/g, '-');
    }

    let resolvedPath = filepath;
    try {
        resolvedPath = require.resolve(filepath);
    } catch (e) {
        // No problem, we keep the initial path.
    }

    return resolvedPath
        .replace(context.bundler.outDir, '')
        .replace(context.cwd, '')
        .replace(/^\/+/, '');
};
