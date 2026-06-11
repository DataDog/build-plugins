// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ChunkInfo, InjectPosition } from '@dd/core/types';

// A static string, an async resolver, or a function resolved per emitted chunk.
export type InjectValue = string | (() => Promise<string>) | ((chunk: ChunkInfo) => string);

export type ContentToInject = {
    allChunks?: boolean;
    position: InjectPosition;
    value: InjectValue;
};
export type ContentsToInject = Array<ContentToInject>;

export type FileToInject = {
    absolutePath: string;
    filename: string;
    toInject: Map<string, string>;
};
export type FilesToInject = Record<InjectPosition, FileToInject>;
