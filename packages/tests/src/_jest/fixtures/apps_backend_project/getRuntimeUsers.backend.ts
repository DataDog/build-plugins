// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
  getExecutionUser,
  getInitiatingUser,
} from '@datadog/apps-backend/user';

export async function getRuntimeUsers(label: string) {
  const [executionUser, initiatingUser] = await Promise.all([
    getExecutionUser(),
    getInitiatingUser(),
  ]);

  return { label, executionUser, initiatingUser };
}

export async function plainEcho(value: string) {
  return { value };
}
