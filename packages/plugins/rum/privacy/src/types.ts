// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export interface RumPrivacyOptions {
    exclude?: RegExp[] | string[];
    include?: RegExp[] | string[];
    module?: 'cjs' | 'esm';
    jsx?: boolean;
    transformStrategy?: 'ast';
    typescript?: boolean;
    disabled?: boolean | undefined;
}
