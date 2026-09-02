// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { helperEcho } from './helper';

// A non-local (npm-package) dynamic import: a local one is already caught by the
// fail-closed unsupportedDependencies check, which would mask the bug this exercises.
await import('chalk');

import { sendSlackMessage } from '@datadog/action-catalog';

export async function usesMixedImports(value: string) {
    await helperEcho(value);
    return sendSlackMessage({ inputs: { text: value }, connectionId: 'conn-1' });
}
