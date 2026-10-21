// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Only the child-process test server defines these modules.
import { virtualValue } from 'virtual:dd-child-test';
import { slashValue } from '/~dd-child-test-virtual.js';

export async function readVirtualModule() {
    return { virtualValue, slashValue };
}
