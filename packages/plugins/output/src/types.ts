// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Assign } from '@dd/core/types';

import type { FILE_KEYS } from './constants';

export type FileKey = (typeof FILE_KEYS)[number];
export type FileValue = boolean | string;
export type DefaultFileValue = string | false;
export type OutputOptions = {
    enable?: boolean;
    files?: {
        [K in FileKey]?: FileValue;
    };
    path?: string;
};

export type OutputOptionsWithDefaults = Assign<
    Required<OutputOptions>,
    {
        files: {
            [K in FileKey]: DefaultFileValue;
        };
    }
>;
