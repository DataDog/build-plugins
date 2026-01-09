// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// This file is dynamically imported to ensure bundlers produce a separate chunk.
// Used for testing injectIntoAllChunks functionality.

export const dynamicChunkFunction = () => {
    return 'DYNAMIC_CHUNK_LOADED';
};

export default dynamicChunkFunction;


