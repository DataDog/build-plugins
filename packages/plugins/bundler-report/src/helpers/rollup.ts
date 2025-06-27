import { getHighestPackageJsonDir, getNearestCommonDirectory } from '@dd/core/helpers/paths';
import path from 'path';
import type { InputOptions, OutputOptions, RollupOptions } from 'rollup';

// Compute the CWD based on a list of directories.
const getCwd = (dirs: Set<string>) => {
    for (const dir of dirs) {
        // eslint-disable-next-line no-undef
        const highestPackage = getHighestPackageJsonDir(dir);
        if (highestPackage && !dirs.has(highestPackage)) {
            dirs.add(highestPackage);
        }
    }

    // Fall back to the nearest common directory.
    const nearestDir = getNearestCommonDirectory(Array.from(dirs));
    if (nearestDir !== path.sep) {
        return nearestDir;
    }
};

export const getAbsoluteOutDir = (cwd: string, outDir: string) => {
    if (!outDir) {
        return '';
    }

    return path.isAbsolute(outDir) ? outDir : path.resolve(cwd, outDir);
};

export const getOutDirFromOutputs = (outputOptions: RollupOptions['output']) => {
    if (!outputOptions) {
        return '';
    }

    const normalizedOutputOptions = Array.isArray(outputOptions) ? outputOptions : [outputOptions];
    let outDir: string = '';
    // FIXME: This is an oversimplification, we should handle builds with multiple outputs.
    // Ideally, `outDir` should only be computed for the build-report.
    // And build-report should also handle multiple outputs.
    for (const output of normalizedOutputOptions) {
        if (output.dir) {
            outDir = output.dir;
        } else if (output.file) {
            outDir = path.dirname(output.file);
        }
    }

    return outDir;
};

export const computeOutDir = (options: InputOptions) => {
    if ('output' in options) {
        return getAbsoluteOutDir(
            process.cwd(),
            getOutDirFromOutputs(options.output as OutputOptions),
        );
    } else {
        // Fallback to process.cwd()/dist as it is rollup's default.
        return path.resolve(process.cwd(), 'dist');
    }
};

export const computeCwd = (options: InputOptions) => {
    const directoriesForCwd: Set<string> = new Set();

    if (options.input) {
        const normalizedInput = Array.isArray(options.input)
            ? options.input
            : typeof options.input === 'object'
              ? Object.values(options.input)
              : [options.input];

        for (const input of normalizedInput) {
            if (typeof input === 'string') {
                directoriesForCwd.add(path.dirname(input));
            } else {
                throw new Error('Invalid input type');
            }
        }
    }

    // In case an absolute path has been provided in the output options,
    // we include it in the directories list for CWD computation.
    if (
        'output' in options &&
        path.isAbsolute(getOutDirFromOutputs(options.output as OutputOptions))
    ) {
        directoriesForCwd.add(computeOutDir(options));
    }

    const cwd = getCwd(directoriesForCwd);

    if (cwd) {
        return cwd;
    }

    // Fallbacks
    return process.cwd();
};
