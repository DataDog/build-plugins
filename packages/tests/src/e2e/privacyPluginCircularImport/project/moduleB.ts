// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as moduleC from './moduleC';

// Force immediate execution during module load
const funcName = 'finalizeInModuleC';  // String that plugin will extract
export const initialProcess = moduleC[funcName]('init');

// Function name that will be extracted as a string
export function transformInModuleB(value: string) {
    return `Processed in B: ${value}`;
}