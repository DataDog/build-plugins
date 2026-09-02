// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { plainEcho } from './getRuntimeUsers.backend';

export async function helperEcho(value: string) {
    return plainEcho(value);
}
