// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Assign } from '@dd/core/types';

export interface PrivacyOptions {
    exclude?: RegExp[] | string[];
    include?: RegExp[] | string[];
    module?: 'cjs' | 'esm';
    jsx?: boolean;
    transformStrategy?: 'ast';
    typescript?: boolean;
    disabled?: boolean | undefined;
}

export type PrivacyOptionsWithDefaults = Assign<
    PrivacyOptions,
    Pick<Required<PrivacyOptions>, 'exclude' | 'include' | 'module' | 'transformStrategy'>
>;
