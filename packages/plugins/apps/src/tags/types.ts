// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';

import type { AppsOptionsWithDefaults } from '../types';

/** A JavaScript chunk of the frontend as it ships: after tree-shaking and minification. */
export type ShippedChunk = {
    fileName: string;
    code: string;
};

export type TagSourceContext = {
    options: AppsOptionsWithDefaults;
    log: Logger;
};

/** Contributes tags for one build. */
export type TagSource = {
    /** Sees each shipped frontend chunk, for sources that derive tags from the app's code. */
    readChunk?: (chunk: ShippedChunk) => void;
    /** This build's tags, once every chunk has been read. */
    tags: () => string[];
};
