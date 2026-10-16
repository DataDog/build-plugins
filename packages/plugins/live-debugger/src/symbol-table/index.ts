// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJson, readFile } from '@dd/core/helpers/fs';
import type { BuildReport, GlobalContext, Logger, Output, PluginOptions } from '@dd/core/types';
import path from 'path';

import { SYMBOL_TABLE_MAX_PART_BYTES, SYMBOL_TABLE_PATH_ENV } from '../constants';
import type { LiveDebuggerOptionsWithDefaults } from '../types';

import { createBuildModeTracker } from './build-mode';
import { loadSourceMap, locateFunctions } from './locate';
import { createSourceFileResolver, getRepositoryRoot, isInsideDirectory } from './paths';
import { readChunkDebugId, scanChunk } from './scan';
import type { SymbolTablePayload } from './serialize';
import { serializeSymbolTable } from './serialize';
import { buildSymbolTable } from './table';
import type { ChunkFunction, ChunkFunctions, SymbolTable } from './types';
import { uploadSymbolTable } from './upload';

const LOG_PREFIX = 'Live Debugger symbol table';
const JS_OUTPUT_TYPES = new Set(['js', 'mjs', 'cjs']);

type GenerateSymbolTableArgs = {
    outputs: Output[];
    buildRoot: string;
    log: Logger;
};

const getFirst = (values: Set<string>) => values.values().next().value;

const byFilepath = (a: Output, b: Output) => {
    if (a.filepath === b.filepath) {
        return 0;
    }
    return a.filepath < b.filepath ? -1 : 1;
};

/**
 * List the instrumented functions that ship in the build's output, with their path relative to
 * the repository root and their original line range.
 */
export const generateSymbolTable = async ({
    outputs,
    buildRoot,
    log,
}: GenerateSymbolTableArgs): Promise<SymbolTable | undefined> => {
    const repositoryRoot = getRepositoryRoot(buildRoot);
    if (!repositoryRoot) {
        log.warn(`Skipping the ${LOG_PREFIX}: the build root isn't in a git repository.`);
        return undefined;
    }

    const chunkOutputs = outputs.filter((output) => JS_OUTPUT_TYPES.has(output.type));
    chunkOutputs.sort(byFilepath);

    const chunks: ChunkFunctions[] = [];
    let chunksWithoutSourceMap = 0;
    let unpairedChunks = 0;
    let chunksWithoutDebugId = 0;

    // One chunk at a time, so at most one source map is in memory.
    for (const output of chunkOutputs) {
        // eslint-disable-next-line no-await-in-loop
        const code = await readFile(output.filepath);
        const scan = scanChunk(code);
        const debugId = readChunkDebugId(code);
        let functions: ChunkFunction[] = [];

        if (scan.functions.length > 0) {
            // eslint-disable-next-line no-await-in-loop
            const traceMap = await loadSourceMap(output.filepath, code);
            functions = locateFunctions(code, scan, traceMap);
            chunksWithoutSourceMap += Number(!traceMap);
            unpairedChunks += Number(!scan.paired);
            chunksWithoutDebugId += Number(!debugId);
        }

        chunks.push({ filepath: output.filepath, debugId, functions });
    }

    const resolveSourceFile = createSourceFileResolver(buildRoot, repositoryRoot);
    const { table, outsideModulePaths, invalidFunctionIds } = buildSymbolTable(
        chunks,
        resolveSourceFile,
    );

    if (chunksWithoutSourceMap > 0) {
        log.warn(
            `${LOG_PREFIX}: ${chunksWithoutSourceMap} chunk(s) have no source map, so their functions have no line numbers.`,
        );
    }
    if (unpairedChunks > 0) {
        log.warn(
            `${LOG_PREFIX}: the instrumentation markers of ${unpairedChunks} chunk(s) don't pair up, so their functions have no line numbers.`,
        );
    }
    if (chunksWithoutDebugId > 0) {
        log.warn(
            `${LOG_PREFIX}: ${chunksWithoutDebugId} chunk(s) have no debug ID, so chunk debug IDs are left out. Enable "rum.sourceCodeContext.debugId" to include them.`,
        );
    }
    if (outsideModulePaths.size > 0) {
        const exampleModulePath = getFirst(outsideModulePaths);
        log.warn(
            `${LOG_PREFIX}: left out the functions of ${outsideModulePaths.size} file(s) outside the git repository, such as "${exampleModulePath}".`,
        );
    }
    if (invalidFunctionIds.size > 0) {
        const exampleFunctionId = getFirst(invalidFunctionIds);
        log.warn(
            `${LOG_PREFIX}: left out ${invalidFunctionIds.size} function(s) with an unexpected ID, such as "${exampleFunctionId}".`,
        );
    }

    return table;
};

// Write the opt-in debug dump. It must never end up in the deployed output.
export const writeSymbolTable = async (
    payload: SymbolTablePayload,
    dumpPath: string,
    outDir: string,
    log: Logger,
) => {
    const absoluteDumpPath = path.resolve(dumpPath);
    if (isInsideDirectory(absoluteDumpPath, outDir)) {
        log.warn(
            `${LOG_PREFIX}: not writing it to "${absoluteDumpPath}", because that's inside the output directory.`,
        );
        return;
    }

    await outputJson(absoluteDumpPath, payload);
    log.info(`${LOG_PREFIX}: wrote ${payload.scopes.length} file(s) to "${absoluteDumpPath}".`);
};

type UploadSettings = {
    apiKey: string;
    site: string;
    service: string;
    version: string;
};

type UploadSetup = { settings: UploadSettings } | { skipReason: string };

// What the upload needs from the configuration. Git data is only known later in the build.
export const getUploadSetup = (
    pluginOptions: LiveDebuggerOptionsWithDefaults,
    context: GlobalContext,
): UploadSetup => {
    const { apiKey, site } = context.auth;
    const { service, version, enableGit } = pluginOptions;

    if (!apiKey) {
        return { skipReason: 'no API key is configured' };
    }
    if (!service) {
        return {
            skipReason:
                'no service is configured. Set "liveDebugger.service" or "rum.sourceCodeContext.service"',
        };
    }
    if (!version) {
        return { skipReason: 'no version is configured. Set "metadata.version"' };
    }
    if (!enableGit) {
        return { skipReason: 'git is disabled with "enableGit: false"' };
    }

    return { settings: { apiKey, site, service, version } };
};

/**
 * Hooks that generate the symbol table after one-off builds and upload it to SymDB. Live Debugger
 * needs the table to create probes, so the upload is on by default. When the table can't be
 * uploaded, it's only generated for the opt-in debug dump, so other builds don't do any extra work.
 * The table never fails the build.
 */
export const getSymbolTableHooks = (
    pluginOptions: LiveDebuggerOptionsWithDefaults,
    context: GlobalContext,
    log: Logger,
): Partial<PluginOptions> => {
    const dumpPath = process.env[SYMBOL_TABLE_PATH_ENV];
    const uploadSetup = getUploadSetup(pluginOptions, context);
    const buildMode = createBuildModeTracker();

    const upload = async (
        payload: SymbolTablePayload,
        functionCount: number,
        settings: UploadSettings,
    ) => {
        // The git plugin collects git data while the build runs.
        await context.gitReady;
        const repositoryData = context.git;
        if (!repositoryData) {
            log.warn(
                `Not uploading the ${LOG_PREFIX}: no git repository data, for instance because the repository has no remote.`,
            );
            return;
        }

        const timer = log.time('upload symbol table');
        try {
            const partCount = await uploadSymbolTable(
                payload,
                {
                    ...settings,
                    repositoryUrl: repositoryData.remote,
                    commitSha: repositoryData.hash,
                    bundlerName: context.bundler.name,
                    pluginVersion: context.version,
                },
                SYMBOL_TABLE_MAX_PART_BYTES,
                log,
            );
            log.info(
                `${LOG_PREFIX}: uploaded ${functionCount} function(s) from ${payload.scopes.length} file(s) in ${partCount} part(s).`,
            );
        } catch (error) {
            log.warn(`Could not upload the ${LOG_PREFIX}: ${error}`);
        } finally {
            timer.end();
        }
    };

    const handleSymbolTable = async (report: BuildReport) => {
        // Wait for the injection plugin to finish rewriting esbuild's output.
        await context.artifactsReady;

        const timer = log.time('generate symbol table');
        let table: SymbolTable | undefined;
        let payload: SymbolTablePayload | undefined;
        try {
            table = await generateSymbolTable({
                outputs: report.outputs ?? [],
                buildRoot: context.buildRoot,
                log,
            });
            payload = table && serializeSymbolTable(table, pluginOptions.version);
        } catch (error) {
            log.warn(`Could not generate the ${LOG_PREFIX}: ${error}`);
        } finally {
            timer.end();
        }

        if (!table || !payload) {
            return;
        }

        if (dumpPath) {
            try {
                await writeSymbolTable(payload, dumpPath, context.bundler.outDir, log);
            } catch (error) {
                log.warn(`Could not write the ${LOG_PREFIX}: ${error}`);
            }
        }

        if ('settings' in uploadSetup) {
            await upload(payload, table.entries.length, uploadSetup.settings);
        }
    };

    return {
        ...buildMode.hooks,
        async buildReport(report) {
            if (!buildMode.isOneOffBuild()) {
                return;
            }

            if ('skipReason' in uploadSetup) {
                log.warn(`Not uploading the ${LOG_PREFIX}: ${uploadSetup.skipReason}.`);
                if (!dumpPath) {
                    return;
                }
            }

            // Let the bundler finish while the output or the git data is still in progress.
            const handling = handleSymbolTable(report);
            if (context.artifactsPending || context.gitPending) {
                context.queue(handling);
                return;
            }
            await handling;
        },
    };
};
