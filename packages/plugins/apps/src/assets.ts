// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { glob } from 'glob';
import path from 'path';

export type Asset = {
    absolutePath: string;
    relativePath: string;
};

export const collectAssets = async (patterns: string[], cwd: string): Promise<Asset[]> => {
    const matches = (
        await Promise.all(
            patterns.map((pattern) => {
                return glob(pattern, { absolute: true, cwd, nodir: true });
            }),
        )
    ).flat();

    const assets: Asset[] = Array.from(new Set(matches)).map((match) => {
        const relativePath = path.relative(cwd, match);
        return {
            absolutePath: match,
            relativePath,
        };
    });

    return assets;
};
