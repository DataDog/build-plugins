// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { forgeInvoke, probeSandbox } from './childSandboxProbes';

export async function runSandboxProbes(projectFile: string, fetchUrl: string, sharedTmpFile: string) {
    return probeSandbox(projectFile, fetchUrl, sharedTmpFile);
}

export async function loadOverIpc(url: string, importer?: string) {
    return forgeInvoke(url, importer);
}
