// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

/** Built from `local-execution-child.ts` next to the published bundle. */
export function getLocalExecutionChildPath(): string {
    return path.join(__dirname, './local-execution-child.mjs');
}
