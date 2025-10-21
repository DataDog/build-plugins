// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerName } from '@dd/core/types';
import type { BundlerConfigFunction } from '@dd/tools/bundlers';

export type Bundler = {
    name: BundlerName;
    config: BundlerConfigFunction;
    plugin: any;
    run: BundlerRunFunction;
    version: string;
};

export type RunResult = {
    errors: string[];
    workingDir: string;
};
export type CleanupFn = (() => Promise<void>) & RunResult;
export type BundlerRunFunction = (seed: string, configuration: any) => Promise<CleanupFn>;
