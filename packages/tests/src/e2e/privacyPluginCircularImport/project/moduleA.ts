// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as moduleB from './moduleB';

// Force immediate execution during module load
const funcName = 'transformInModuleB';  // String that plugin will extract
export const initialValue = moduleB[funcName]('start');

// Function name that will be extracted as a string
export function processInModuleA(value: string) {
    return `Processed in A: ${value}`;
}