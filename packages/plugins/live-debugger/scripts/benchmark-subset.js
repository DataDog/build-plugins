// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { performance } = require('perf_hooks');
const ts = require('typescript');

const pluginRoot = path.resolve(__dirname, '..');
const supportedExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);

// Node.js internal API for custom require extension hooks.
function compileModule(mod, code, filename) {
    const compileFn = Reflect.get(mod, '_compile');
    compileFn.call(mod, code, filename);
}

function registerTsLoader(rootDir) {
    const originalLoader = require.extensions['.ts'];

    require.extensions['.ts'] = (module, filename) => {
        if (!filename.startsWith(rootDir)) {
            if (originalLoader) {
                return originalLoader(module, filename);
            }

            // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
            const source = fs.readFileSync(filename, 'utf8');
            return compileModule(module, source, filename);
        }

        // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
        const source = fs.readFileSync(filename, 'utf8');
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: {
                esModuleInterop: true,
                jsx: ts.JsxEmit.React,
                module: ts.ModuleKind.CommonJS,
                moduleResolution: ts.ModuleResolutionKind.NodeJs,
                target: ts.ScriptTarget.ES2020,
            },
            fileName: filename,
        });

        return compileModule(module, outputText, filename);
    };
}

function formatBytes(bytes) {
    const sign = bytes > 0 ? '+' : '';

    return `${sign}${bytes.toLocaleString()} B`;
}

function formatPercent(before, after) {
    if (before === 0) {
        return 'n/a';
    }

    const change = ((after - before) / before) * 100;
    const sign = change > 0 ? '+' : '';

    return `${sign}${change.toFixed(2)}%`;
}

function formatMs(value) {
    return `${value.toFixed(2)} ms`;
}

function gzipSize(code) {
    return zlib.gzipSync(code).length;
}

function collectFilesRecursively(targetPath) {
    const stats = fs.statSync(targetPath);

    if (stats.isFile()) {
        const name = path.basename(targetPath);
        if (name.endsWith('.d.ts') || name.endsWith('.d.tsx')) {
            return [];
        }
        return supportedExtensions.has(path.extname(targetPath)) ? [targetPath] : [];
    }

    if (!stats.isDirectory()) {
        return [];
    }

    const children = fs.readdirSync(targetPath, { withFileTypes: true });

    return children.flatMap((child) => collectFilesRecursively(path.join(targetPath, child.name)));
}

function resolveInputFiles(rawArgs) {
    const args = rawArgs.filter((arg) => !arg.startsWith('--'));

    if (args.length === 0) {
        console.error(
            'Usage: benchmark-subset <file-or-directory...> [--repeat=N] [--limit=N] [--verbose]',
        );
        process.exit(1);
    }

    const resolvedPaths = args.map((filePath) =>
        path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath),
    );

    const expandedFiles = resolvedPaths.flatMap((resolvedPath) =>
        collectFilesRecursively(resolvedPath),
    );

    return Array.from(new Set(expandedFiles)).sort();
}

function getRepeatCount(rawArgs) {
    const repeatArg = rawArgs.find((arg) => arg.startsWith('--repeat='));
    const fromArg = repeatArg ? Number(repeatArg.split('=')[1]) : undefined;
    const fromEnv = process.env.DD_LIVE_DEBUGGER_BENCH_REPEAT
        ? Number(process.env.DD_LIVE_DEBUGGER_BENCH_REPEAT)
        : undefined;
    const value = fromArg ?? fromEnv ?? 5;

    if (!Number.isFinite(value) || value < 1) {
        throw new Error(`Invalid repeat count: ${value}`);
    }

    return Math.floor(value);
}

function getLimit(rawArgs) {
    const limitArg = rawArgs.find((arg) => arg.startsWith('--limit='));

    if (!limitArg) {
        return Infinity;
    }

    const value = Number(limitArg.split('=')[1]);

    if (!Number.isFinite(value) || value < 1) {
        throw new Error(`Invalid limit: ${limitArg.split('=')[1]}`);
    }

    return Math.floor(value);
}

function benchmarkOperation(repeatCount, operation) {
    const timings = [];
    let lastResult;

    for (let index = 0; index < repeatCount; index += 1) {
        const startedAt = performance.now();
        lastResult = operation();
        timings.push(performance.now() - startedAt);
    }

    const totalDurationMs = timings.reduce((sum, value) => sum + value, 0);
    const avgDurationMs = totalDurationMs / repeatCount;

    return {
        avgDurationMs,
        lastResult,
        totalDurationMs,
    };
}

function benchmarkFile(filePath, repeatCount, buildRoot) {
    // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
    const code = fs.readFileSync(filePath, 'utf8');
    const baselineResult = benchmarkOperation(repeatCount, () => ({ code }));
    const activeResult = benchmarkOperation(repeatCount, () =>
        transformCode({
            buildRoot,
            code,
            filePath,
            honorSkipComments: false,
            functionTypes: undefined,
            namedOnly: false,
        }),
    );

    const originalBytes = Buffer.byteLength(code);
    const transformedBytes = Buffer.byteLength(activeResult.lastResult.code);
    const originalGzipBytes = gzipSize(code);
    const transformedGzipBytes = gzipSize(activeResult.lastResult.code);

    return {
        activeAvgDurationMs: activeResult.avgDurationMs,
        activeTotalDurationMs: activeResult.totalDurationMs,
        baselineAvgDurationMs: baselineResult.avgDurationMs,
        baselineTotalDurationMs: baselineResult.totalDurationMs,
        failedCount: activeResult.lastResult.failedCount,
        filePath,
        instrumentedCount: activeResult.lastResult.instrumentedCount,
        originalBytes,
        originalGzipBytes,
        skippedByCommentCount: activeResult.lastResult.skippedByCommentCount,
        skippedUnsupportedCount: activeResult.lastResult.skippedUnsupportedCount,
        totalFunctions: activeResult.lastResult.totalFunctions,
        transformedBytes,
        transformedGzipBytes,
    };
}

function printFileResult(result, buildRoot) {
    const relativePath = path.relative(buildRoot, result.filePath);

    console.log(`\n${relativePath}`);
    console.log(
        `  functions: ${result.instrumentedCount}/${result.totalFunctions} instrumented` +
            ` | failed=${result.failedCount}` +
            ` | skippedUnsupported=${result.skippedUnsupportedCount}` +
            ` | skippedByComment=${result.skippedByCommentCount}`,
    );
    console.log(
        `  raw size: ${result.originalBytes.toLocaleString()} -> ${result.transformedBytes.toLocaleString()} ` +
            `(${formatBytes(result.transformedBytes - result.originalBytes)}, ${formatPercent(result.originalBytes, result.transformedBytes)})`,
    );
    console.log(
        `  gzip size: ${result.originalGzipBytes.toLocaleString()} -> ${result.transformedGzipBytes.toLocaleString()} ` +
            `(${formatBytes(result.transformedGzipBytes - result.originalGzipBytes)}, ${formatPercent(result.originalGzipBytes, result.transformedGzipBytes)})`,
    );
    console.log(
        `  plugin off time: avg ${formatMs(result.baselineAvgDurationMs)} across ${repeatCount} run(s)` +
            ` | total ${formatMs(result.baselineTotalDurationMs)}`,
    );
    console.log(
        `  plugin on time: avg ${formatMs(result.activeAvgDurationMs)} across ${repeatCount} run(s)` +
            ` | total ${formatMs(result.activeTotalDurationMs)}`,
    );
    console.log(
        `  transform overhead: avg ${formatMs(result.activeAvgDurationMs - result.baselineAvgDurationMs)}` +
            ` | total ${formatMs(result.activeTotalDurationMs - result.baselineTotalDurationMs)}`,
    );
}

const rawArgs = process.argv.slice(2);
const verbose = rawArgs.includes('--verbose');
const repeatCount = getRepeatCount(rawArgs);
const limit = getLimit(rawArgs);
let files = resolveInputFiles(rawArgs);

if (files.length > limit) {
    console.log(
        `Limiting from ${files.length.toLocaleString()} to ${limit.toLocaleString()} files (--limit=${limit})`,
    );
    files = files.slice(0, limit);
}

registerTsLoader(pluginRoot);

const { transformCode } = require('../src/transform/index.ts');

for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
}

const buildRoot = files.reduce((ancestor, filePath) => {
    const dir = path.dirname(filePath);
    let current = ancestor;

    while (!dir.startsWith(current)) {
        current = path.dirname(current);
    }

    return current;
}, path.dirname(files[0]));

console.log(`Live Debugger subset benchmark`);
console.log(`build root: ${buildRoot}`);
console.log(`files: ${files.length}`);
console.log(`repeat count: ${repeatCount}`);
console.log();

const verboseResults = [];
const totals = {
    activeAvgDurationMs: 0,
    activeTotalDurationMs: 0,
    baselineAvgDurationMs: 0,
    baselineTotalDurationMs: 0,
    failedCount: 0,
    instrumentedCount: 0,
    originalBytes: 0,
    originalGzipBytes: 0,
    skippedByCommentCount: 0,
    skippedUnsupportedCount: 0,
    totalFunctions: 0,
    transformedBytes: 0,
    transformedGzipBytes: 0,
};
const barWidth = 30;
const total = files.length;

for (let i = 0; i < total; i += 1) {
    const filled = Math.round(((i + 1) / total) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const pct = Math.round(((i + 1) / total) * 100);
    const label = `  Benchmarking [${bar}] ${i + 1}/${total} (${pct}%)`;
    process.stderr.write(`${label}\r`);

    const result = benchmarkFile(files[i], repeatCount, buildRoot);

    totals.activeAvgDurationMs += result.activeAvgDurationMs;
    totals.activeTotalDurationMs += result.activeTotalDurationMs;
    totals.baselineAvgDurationMs += result.baselineAvgDurationMs;
    totals.baselineTotalDurationMs += result.baselineTotalDurationMs;
    totals.failedCount += result.failedCount;
    totals.instrumentedCount += result.instrumentedCount;
    totals.originalBytes += result.originalBytes;
    totals.originalGzipBytes += result.originalGzipBytes;
    totals.skippedByCommentCount += result.skippedByCommentCount;
    totals.skippedUnsupportedCount += result.skippedUnsupportedCount;
    totals.totalFunctions += result.totalFunctions;
    totals.transformedBytes += result.transformedBytes;
    totals.transformedGzipBytes += result.transformedGzipBytes;

    if (verbose) {
        verboseResults.push(result);
    }
}

process.stderr.write(`${' '.repeat(barWidth + 40)}\r`);

if (verbose) {
    for (const result of verboseResults) {
        printFileResult(result, buildRoot);
    }
}

console.log(`\nTotals`);
console.log(
    `  functions: ${totals.instrumentedCount}/${totals.totalFunctions} instrumented` +
        ` | failed=${totals.failedCount}` +
        ` | skippedUnsupported=${totals.skippedUnsupportedCount}` +
        ` | skippedByComment=${totals.skippedByCommentCount}`,
);
console.log(
    `  raw size: ${totals.originalBytes.toLocaleString()} -> ${totals.transformedBytes.toLocaleString()} ` +
        `(${formatBytes(totals.transformedBytes - totals.originalBytes)}, ${formatPercent(totals.originalBytes, totals.transformedBytes)})`,
);
console.log(
    `  gzip size: ${totals.originalGzipBytes.toLocaleString()} -> ${totals.transformedGzipBytes.toLocaleString()} ` +
        `(${formatBytes(totals.transformedGzipBytes - totals.originalGzipBytes)}, ${formatPercent(totals.originalGzipBytes, totals.transformedGzipBytes)})`,
);
console.log(
    `  plugin off time: avg ${formatMs(totals.baselineAvgDurationMs)} per subset pass` +
        ` | total ${formatMs(totals.baselineTotalDurationMs)}`,
);
console.log(
    `  plugin on time: avg ${formatMs(totals.activeAvgDurationMs)} per subset pass` +
        ` | total ${formatMs(totals.activeTotalDurationMs)}`,
);
console.log(
    `  transform overhead: avg ${formatMs(totals.activeAvgDurationMs - totals.baselineAvgDurationMs)}` +
        ` | total ${formatMs(totals.activeTotalDurationMs - totals.baselineTotalDurationMs)}`,
);
