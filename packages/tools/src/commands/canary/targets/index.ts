// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { CanaryTarget } from '../types';

import { webUiTarget } from './web-ui';

const targets = new Map<string, CanaryTarget>([[webUiTarget.id, webUiTarget]]);

export const getCanaryTarget = (name: string): CanaryTarget | undefined => {
    return targets.get(name);
};

export const getCanaryTargetNames = (): string[] => {
    return Array.from(targets.keys()).sort();
};
