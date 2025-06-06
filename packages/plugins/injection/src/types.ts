// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { InjectPosition, ToInjectItem } from '@dd/core/types';

export type ContentsToInject = {
    [InjectPosition.BEFORE]: Map<string, ToInjectItem>;
    [InjectPosition.MIDDLE]: Map<string, ToInjectItem>;
    [InjectPosition.AFTER]: Map<string, ToInjectItem>;
};

export type FileToInject = {
    absolutePath: string;
    filename: string;
    toInject: Map<string, string>;
};
export type FilesToInject = Record<InjectPosition, FileToInject>;
