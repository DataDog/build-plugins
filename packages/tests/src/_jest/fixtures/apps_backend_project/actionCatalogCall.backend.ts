// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { sendSlackMessage } from '@datadog/action-catalog';

export async function postMessage() {
  return sendSlackMessage({ inputs: { text: 'hi' }, connectionId: 'conn-1' });
}
