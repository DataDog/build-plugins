// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Assign, Ensure } from '@dd/core/types';

export type ServerOptions = {
    port: number;
    run: boolean;
};

export type SyntheticsOptions = {
    disabled?: boolean;
};

export type SyntheticsOptionsWithDefaults = Assign<
    Ensure<SyntheticsOptions, 'disabled'>,
    {
        server?: ServerOptions;
    }
>;

export type BuildStatus = 'running' | 'success' | 'fail';
export type ServerResponse = { outDir?: string; publicPath?: string; status: BuildStatus };
