// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { InjectPosition, type PluginOptions } from '@dd/core/types';

import { getContentToInject } from './helpers';
import type { ContentsToInject } from './types';

// Rollup uses its own banner hook.
// We use its native functionality.
// TODO: Add the other injection points.
export const getRollupPlugin = (contentsToInject: ContentsToInject): PluginOptions['rollup'] => ({
    banner(chunk) {
        if (chunk.isEntry) {
            return getContentToInject(contentsToInject[InjectPosition.BEFORE]);
        }
        return '';
    },
});
