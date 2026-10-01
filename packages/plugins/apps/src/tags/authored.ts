// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { TagSource, TagSourceContext } from './types';

/** The tags configured in `apps.tags`. */
export const authoredTagSource = ({ options }: TagSourceContext): TagSource => ({
    tags: () => [...options.tags],
});
