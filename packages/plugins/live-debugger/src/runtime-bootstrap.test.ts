// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getChunkDebugId } from '@dd/core/helpers/debugId';
import type { ChunkInfo } from '@dd/core/types';
import vm from 'vm';

import { getRuntimeBootstrap } from './runtime-bootstrap';

const BUILD_METADATA_GLOBAL = '__DD_LIVE_DEBUGGER_BUILD__';

const getChunk = (sourceOrHash: string): ChunkInfo => ({
    sourceOrHash,
    fileName: `${sourceOrHash}.js`,
    isEntry: false,
});

// Run the given chunk bootstraps, in order, in the same fresh global scope and return it.
const runInFreshGlobal = (...codes: string[]): vm.Context => {
    const globalScope = vm.createContext({});
    for (const code of codes) {
        vm.runInContext(code, globalScope);
    }
    return globalScope;
};

describe('getRuntimeBootstrap', () => {
    const chunk = getChunk('console.log("chunk");');
    const chunkDebugId = getChunkDebugId(chunk);

    const cases = [
        {
            description: 'expose the chunk debug ID',
            options: { service: undefined, debugId: true },
            chunk,
            expected: { debugId: chunkDebugId },
        },
        {
            description: 'expose the service and the chunk debug ID',
            options: { service: 'checkout', debugId: true },
            chunk,
            expected: { service: 'checkout', debugId: chunkDebugId },
        },
        {
            description: 'expose the service only when debug IDs are disabled',
            options: { service: 'checkout', debugId: false },
            chunk,
            expected: { service: 'checkout' },
        },
        {
            description: 'expose empty build metadata without a service or debug IDs',
            options: { service: undefined, debugId: false },
            chunk,
            expected: {},
        },
        {
            description: 'not expose a debug ID without chunk information',
            options: { service: 'checkout', debugId: true },
            chunk: undefined,
            expected: { service: 'checkout' },
        },
        {
            description: 'safely serialize the service',
            options: { service: `checkout"'\\</script>\u2028`, debugId: false },
            chunk,
            expected: { service: `checkout"'\\</script>\u2028` },
        },
    ];

    test.each(cases)('should $description', ({ options, chunk: inputChunk, expected }) => {
        const code = getRuntimeBootstrap(options)(inputChunk);
        const globalScope = runInFreshGlobal(code);

        // Instrumented functions only call `$dd_probes2` once the SDK has defined it.
        expect(typeof globalScope.$dd_probes2).toBe('undefined');
        // The vm returns objects from another realm, so compare their JSON shape.
        const serializedBuildMetadata = JSON.stringify(globalScope[BUILD_METADATA_GLOBAL]);
        const buildMetadata = JSON.parse(serializedBuildMetadata);
        expect(buildMetadata).toEqual(expected);
    });

    test('should be a per-chunk injected value', () => {
        const bootstrap = getRuntimeBootstrap({
            service: undefined,
            debugId: true,
        });

        // The injection plugin only passes chunk info to functions with a single parameter.
        expect(bootstrap).toHaveLength(1);
    });

    test('should keep the build metadata of the first chunk to execute', () => {
        const bootstrap = getRuntimeBootstrap({
            service: undefined,
            debugId: true,
        });
        const firstChunk = getChunk('first chunk');
        const secondChunk = getChunk('second chunk');
        const firstChunkCode = bootstrap(firstChunk);
        const secondChunkCode = bootstrap(secondChunk);

        const globalScope = runInFreshGlobal(firstChunkCode, secondChunkCode);
        const firstChunkDebugId = getChunkDebugId(firstChunk);

        expect(globalScope[BUILD_METADATA_GLOBAL].debugId).toBe(firstChunkDebugId);
    });
});
